/**
 * Core — the browser side of the runtime's per-process state, counterpart of
 * PHP `Newspack_Nodes\Core`. It owns the clock, the log-line prefix, the
 * rate-limited stderr path and the bounded ring the `dmesg` verb reads, the
 * secret-name rule every redactor asks, and the two rebuild signals a mounted
 * graph subscribes to.
 *
 * The name TABLE is deliberately elsewhere: `NodeRegistry` owns it, and Core
 * keeps one as the default every node registers in. Perl draws the same line —
 * `%Tachikoma::Nodes` is the table, `$Tachikoma::Now` is not — so an
 * interpreter that needs a private namespace takes a second registry, never a
 * second clock.
 *
 * The dependency on `IoTelemetry` runs one way. Core classifies every stderr
 * line into it, and IoTelemetry inlines its own seconds clock rather than
 * import Core back, because that edge would close a cycle.
 */

import { newMessage, TYPE, TIMESTAMP, VALUE, TM_BYTESTREAM } from './message';
import names from './reserved-node-names.json';
import { IoTelemetry } from './io-telemetry';
import { NodeRegistry } from './node-registry';

/**
 * The window `printLessOften` collapses one key's repeats inside. PHP spells
 * the same 60 seconds as `Core::$log_timeout` and sweeps expired keys in
 * `prune_logs()` on the Router tick; comparing against the stored timestamp
 * needs no sweep.
 */
const PRINT_LESS_OFTEN_WINDOW_MS = 60_000;

/**
 * Lines the stderr tail keeps for the `dmesg` verb. Tachikoma caps its
 * RECENT_LOG ring at the same 100.
 */
const RECENT_LOG_MAX = 100;

/** A line already carrying a log prefix: the date sits at column 0. */
const PREFIXED = /^\d{4}-\d\d-\d\d/;

/**
 * The formatter every stamp is composed through, built on first use and kept.
 *
 * Constructing a formatter costs 28.5µs against 2.2µs to format with one, and
 * the overlay stamps its whole 200-line ring on every new message, so building
 * one per line is roughly 13x the work. Re-resolving the zone per line to
 * catch a viewer who MOVED is not the cheap half of that trade:
 * `resolvedOptions()` builds a formatter too, at 21.4µs, which is nearly the
 * whole saving for a case a debug overlay can meet with a reload. `reset()`
 * clears it, which is the deliberate way back.
 */
let stampFormatter = null;

/**
 * `YYYY-MM-DD HH:MM:SS <zone>` in the reader's own zone — strftime's
 * `%F %T %Z`. Assembled from parts by NAME, so neither the locale's field
 * order nor its separators can reach the output: they are the format here, not
 * a preference.
 *
 * @param {number} seconds Epoch seconds.
 * @return {string} The stamp, without a trailing space.
 */
function localStamp( seconds ) {
	if ( ! stampFormatter ) {
		stampFormatter = new Intl.DateTimeFormat( 'en-CA', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
			timeZoneName: 'short',
		} );
	}
	const part = Object.fromEntries(
		stampFormatter
			.formatToParts( new Date( seconds * 1000 ) )
			.map( ( { type, value } ) => [ type, value ] )
	);
	return `${ part.year }-${ part.month }-${ part.day } ${ part.hour }:${ part.minute }:${ part.second } ${ part.timeZoneName }`;
}

/**
 * Mirrors PHP `Core::SECRET_NAME_PATTERNS`. Ask `Core.isSecretProperty()`; the
 * list itself is only for the cross-language pin.
 *
 * @testonly Exported so `secretPatternsParity` pins it against the PHP list.
 * @type {string[]}
 */
export const SECRET_NAME_PATTERNS = [
	'password',
	'passwd',
	'secret',
	'token',
	'credential',
	'api_key',
	'apikey',
	'private_key',
];

/**
 * The per-page process state itself; `Core` at the bottom of this file is the
 * one live instance.
 *
 * Not exported. A second instance is a second graph on the same page, and the
 * window singleton exists to prevent exactly that — so the way back to boot
 * state is `reset()`, which restores the fields in place rather than handing
 * out an object every consumer would have to re-fetch.
 */
class CoreImpl {
	/** Starts at boot state; `reset()` defines what that state is. */
	constructor() {
		this.reset();
	}

	/**
	 * Restore boot state: a fresh registry, zeroed counters, an empty `dmesg`
	 * ring, a re-resolved zone and no rebuild subscribers. Counterpart of PHP
	 * `Core::reset()`; the JS suite calls it in `beforeEach`, so one test's
	 * graph cannot address another's.
	 *
	 * @return {void}
	 */
	reset() {
		// A Router is never removed; a bare swap leaves it ticking on nothing.
		for ( const node of this._registry?.nodes?.values() ?? [] ) {
			node.stopTimer?.();
		}
		// Re-resolve the zone; nothing else re-reads it (see localStamp).
		stampFormatter = null;
		// The name table is its own class; Core keeps ONE as its default.
		this._registry = new NodeRegistry();
		this._msgCounter = 0;
		// Throttle key to the wall-clock ms it last printed at.
		this._lastPrint = new Map();
		// Unread; printLessOften throttles on _lastPrint alone.
		this._countSince = new Map();
		this.recentLog = []; // bounded stderr tail for the dmesg verb
		this._inStderr = false; // re-entry guard for the stderr reply-sink emit
		this.initTime = this.now(); // uptime baseline (PHP Core::$init_time)
		// Overlay Reset-Graph capability; mountExospine sets it.
		this.rebuildable = false;
		this.backboneOwned = false; // a non-passenger mount holds the backbone
		this.backbonePassengers = 0; // live passenger mounts clipped onto it
		// Full-graph rebuild signal: bumping re-runs every graph effect.
		this.graphGeneration = 0;
		// Bumped when a mount CREATES the backbone (bare or delegated).
		this.backboneGeneration = 0;
		this._generationListeners = new Set();
		this._backboneListeners = new Set();
	}

	/**
	 * Print at most one line per key per `PRINT_LESS_OFTEN_WINDOW_MS`, the
	 * counterpart of PHP `Core::print_less_often`.
	 *
	 * The key is `text` — the stable FIRST argument — ONLY. `extra` is variable
	 * payload printed on the occurrence that gets through but never folded into
	 * the key, so a flood of one category with differing values collapses to one
	 * line instead of one per distinct value.
	 *
	 * @param {string}    text  The throttle key, and the head of the line.
	 * @param {...string} extra Tail printed with the head; never keyed.
	 * @return {void}
	 */
	printLessOften( text, ...extra ) {
		const now = Date.now();
		const last = this._lastPrint.get( text ) ?? 0;
		if ( now - last < PRINT_LESS_OFTEN_WINDOW_MS ) {
			return;
		}
		this._lastPrint.set( text, now );
		this.stderr( text + extra.join( '' ) );
	}

	/**
	 * The one entry point for a diagnostic line: prefix it unless it arrives
	 * prefixed, keep a copy in the bounded ring `dmesg` reads, then deliver it
	 * through `_stderr`. Counterpart of PHP `Core::stderr`.
	 *
	 * An empty or nullish line is dropped rather than stamped, so the ring
	 * holds only real lines.
	 *
	 * @param {string} text The line to log, prefixed or bare.
	 * @return {void}
	 */
	stderr( text ) {
		if ( '' === text || null === text || undefined === text ) {
			return;
		}
		const line = this.log_prefixed( text );
		this.recentLog.push( line );
		while ( this.recentLog.length > RECENT_LOG_MAX ) {
			this.recentLog.shift();
		}
		this._stderr( line );
	}

	/**
	 * Deliver one already-composed line: telemetry, console, REPL sink. The
	 * counterpart of PHP `Core::_stderr` — callers that want Shell3's raw
	 * `print {*STDERR}` (no prefix, no recentLog tail) come straight here.
	 *
	 * The REPL leg mints a TM_BYTESTREAM message and fills the sink, because
	 * `fill()` is the only entry point a node has; there is no write method to
	 * call instead.
	 *
	 * @param {string} line The exact text to emit.
	 * @return {void}
	 */
	_stderr( line ) {
		if ( '' === line || null === line || undefined === line ) {
			return;
		}
		// Classify by log convention: WARNING:/ERROR:/else-debug; WARNING wins.
		const trimmed = line.replace( /\n$/, '' );
		if ( /\bWARNING:/.test( line ) ) {
			IoTelemetry.recordWarning( trimmed );
		} else if ( /\bERROR:/.test( line ) ) {
			IoTelemetry.recordError( 1, trimmed );
		} else {
			IoTelemetry.recordDebug( trimmed );
		}
		console.warn( line.replace( /\n$/, '' ) );
		// Also fan the line to the REPL sink (`_repl` else `_output`); guarded.
		if ( ! this._inStderr ) {
			const sink = this.node( names.REPL ) ?? this.node( names.OUTPUT );
			if ( sink ) {
				this._inStderr = true;
				try {
					const m = newMessage();
					m[ TYPE ] = TM_BYTESTREAM;
					m[ TIMESTAMP ] = this.now();
					m[ VALUE ] = line;
					sink.fill( m );
				} finally {
					this._inStderr = false;
				}
			}
		}
	}

	/**
	 * Look one node up in Core's default registry.
	 *
	 * @param {string} name Node name.
	 * @return {?Object} The node, or null — never undefined.
	 */
	node( name ) {
		return this._registry.node( name );
	}

	/**
	 * `text` prefixed unless it already carries one — the rule stderr applies
	 * on the way out, and the overlay applies again over a stored ring, where
	 * a line from Shell3's raw `print {*STDERR}` arrives bare.
	 *
	 * @param {string}  text Line to prefix.
	 * @param {?number} [at] Seconds to stamp; defaults to now.
	 * @return {string} The line, newline-terminated.
	 */
	log_prefixed( text, at = null ) {
		return PREFIXED.test( text )
			? text.replace( /\n+$/, '' ) + '\n'
			: this.log_prefix( text, at );
	}

	/**
	 * Prepend a `YYYY-MM-DD HH:MM:SS <zone> <argv0>: ` prefix to every line,
	 * in the reader's own zone like Tachikoma's Node.pm:459
	 * `strftime( '%F %T %Z', localtime )`. In a browser that zone is the
	 * viewer's, which is what makes a line here comparable to the tab beside it.
	 *
	 * @param {?string} msg  Text to prefix; omitted returns the bare prefix.
	 * @param {?number} [at] Seconds to stamp; defaults to now. A caller
	 *                       prefixing a STORED line passes the moment it was
	 *                       recorded, or a whole ring restamps to one render
	 *                       time.
	 * @return {string} The prefixed text, newline-terminated.
	 */
	log_prefix( msg = null, at = null ) {
		const seconds = null === at || undefined === at ? this.now() : at;
		const prefix = `${ localStamp( seconds ) } ${ this.argv0() }: `;
		if ( null === msg || undefined === msg ) {
			return prefix;
		}
		const chomped = msg.replace( /\n+$/, '' );
		return prefix + chomped.split( '\n' ).join( '\n' + prefix ) + '\n';
	}

	/**
	 * Process identity stamped into every prefix — Perl's `$0`, PHP's worker
	 * type or SAPI name. A browser tab has neither, so the label is fixed, and
	 * it is what tells a reader of a mixed log that the line came from the
	 * page rather than a worker.
	 *
	 * @return {string} The identity label.
	 */
	argv0() {
		return 'browser';
	}

	/**
	 * The runtime clock, in SECONDS with a fractional part — the unit a
	 * message TIMESTAMP, a timer deadline and PHP `Core::$now` all carry.
	 * Milliseconds here would misdate every message crossing the wire.
	 *
	 * @return {number} Epoch seconds.
	 */
	now() {
		return Date.now() / 1000;
	}

	/**
	 * True if a property or argument name reads as a credential (PHP
	 * Core::is_secret_property). The ONE rule every redactor asks.
	 *
	 * @param {string} name Property, key or `--flag` name.
	 * @return {boolean} Whether its value must be masked before display.
	 */
	isSecretProperty( name ) {
		const lower = String( name ).toLowerCase();
		return SECRET_NAME_PATTERNS.some( ( needle ) =>
			lower.includes( needle )
		);
	}

	/**
	 * The live name table, in insertion order — the order `dump_config`
	 * writes. Handed out as the Map itself because callers iterate and query
	 * it directly; a copy would drift from the registry mid-render.
	 *
	 * @return {Map<string,Object>} Nodes by name.
	 */
	get nodes() {
		return this._registry.nodes;
	}

	/**
	 * Signal a FULL rebuild: every mounted graph tears down what it owns and
	 * builds it again. The overlay's Reset Graph removes every node and then
	 * bumps, so the page comes back on canonical wiring.
	 *
	 * @return {void}
	 */
	bumpGraphGeneration() {
		this.graphGeneration++;
		for ( const listener of this._generationListeners ) {
			listener();
		}
	}

	/**
	 * Listen for full-rebuild bumps.
	 *
	 * @param {() => void} listener Called after each bump.
	 * @return {() => boolean} Unsubscribe, for the effect cleanup. Its boolean
	 *                         is what `Set.delete` answered; callers ignore it.
	 */
	subscribeGraphGeneration( listener ) {
		this._generationListeners.add( listener );
		return () => this._generationListeners.delete( listener );
	}

	/**
	 * Announce that the backbone exists, so a passenger mount can clip onto
	 * it.
	 *
	 * Distinct from `graphGeneration` on purpose: a BARE `mountExospine()`
	 * raises the backbone without bumping the generation — the console relies
	 * on that, so a co-mounted overlay is not reinitialized — yet a passenger
	 * node still has to learn the backbone arrived. Generation means "rebuild
	 * what you built"; backbone-up means "there is something to attach to".
	 *
	 * @return {void}
	 */
	notifyBackboneUp() {
		this.backboneGeneration++;
		for ( const listener of this._backboneListeners ) {
			listener();
		}
	}

	/**
	 * Listen for backbone-up notifications. A mount that reuses a backbone
	 * rebuilds its own nodes on this signal, because a replaced backbone
	 * leaves them sinking into a removed node.
	 *
	 * @param {() => void} listener Called after each notification.
	 * @return {() => boolean} Unsubscribe, for the effect cleanup. Its boolean
	 *                         is what `Set.delete` answered; callers ignore it.
	 */
	subscribeBackboneUp( listener ) {
		this._backboneListeners.add( listener );
		return () => this._backboneListeners.delete( listener );
	}

	/**
	 * Add a node to Core's default registry.
	 *
	 * @param {string} name Node name; one already taken throws.
	 * @param {Object} node The node.
	 * @return {void}
	 */
	registerNode( name, node ) {
		this._registry.registerNode( name, node );
	}

	/**
	 * Free a name in Core's default registry. Tearing the node down as well is
	 * `Node.removeNode()`, which unregisters and clears the node's own
	 * references.
	 *
	 * @param {string} name Node name.
	 * @return {void}
	 */
	unregisterNode( name ) {
		this._registry.unregisterNode( name );
	}

	/**
	 * The registry a node registers in unless it was handed another.
	 *
	 * A `CommandInterpreterNode` that owns a child registry gives it to the
	 * nodes it makes, and those stay invisible here — which is what lets an
	 * edit buffer hold a `firehose` while the live graph holds a different
	 * one.
	 *
	 * @return {NodeRegistry} Core's default name table.
	 */
	get registry() {
		return this._registry;
	}

	/**
	 * The next value of the per-page counter, starting at 1. Port of Perl
	 * `Tachikoma::counter()`, which mints identifiers unique within one
	 * process.
	 *
	 * @return {number} The next value; `reset()` starts the sequence over.
	 */
	msgCounter() {
		this._msgCounter++;
		return this._msgCounter;
	}
}

/** Window property the one live `CoreImpl` is parked on. */
const GLOBAL_KEY = '__newspackNodesCore';
if ( ! window[ GLOBAL_KEY ] ) {
	window[ GLOBAL_KEY ] = new CoreImpl();
}

/**
 * The one Core for this page.
 *
 * The console, the debug overlay and each dashboard inline their own copy of
 * this module, so a module-scoped instance would give every bundle a private
 * graph whose nodes could not address each other's. Parking the instance on
 * `window` is what makes them one graph.
 */
export const Core = window[ GLOBAL_KEY ];
