import { newMessage, TYPE, TIMESTAMP, VALUE, TM_BYTESTREAM } from './message';
import names from './reserved-node-names.json';
import { IoTelemetry } from './io-telemetry';
import { NodeRegistry } from './node-registry';

const PRINT_LESS_OFTEN_WINDOW_MS = 60_000;
// Bounded stderr tail for the dmesg verb (Tachikoma caps @RECENT_LOG at 100).
const RECENT_LOG_MAX = 100;
// A line already carrying a log prefix: the date sits at column 0.
const PREFIXED = /^\d{4}-\d\d-\d\d/;

// @longform
// Built on first use and kept. Constructing a formatter costs 28.5µs against
// 2.2µs to format with one, and the overlay stamps its whole 200-line ring on
// every new message — so the per-line construction this replaced was ~13x the
// work. Re-resolving the zone per line to catch a viewer who MOVED is not the
// cheap half of that trade: `resolvedOptions()` builds a formatter too, at
// 21.4µs, which is nearly the whole saving for a case a debug overlay can meet
// with a reload. `reset()` clears it, which is the deliberate way back.
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

class CoreImpl {
	constructor() {
		this.reset();
	}

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
		this._lastPrint = new Map(); // message → last-printed ms timestamp
		this._countSince = new Map(); // message → count since last print
		this.recentLog = []; // bounded stderr tail for the dmesg verb
		this._inStderr = false; // re-entry guard for the stderr reply-sink emit
		this.initTime = this.now(); // uptime baseline (PHP Core::$init_time)
		this.rebuildable = false; // overlay Reset-Graph capability; mountExospine sets it
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
	 * At most one print per category per 60s window (PHP print_less_often).
	 *
	 * The key is `text` — the stable FIRST argument — ONLY. `extra` is variable
	 * payload printed on the occurrence that gets through but never folded into
	 * the key, so a flood of one category with differing values collapses to one
	 * line instead of one per distinct value.
	 *
	 * @param {string}    text  The throttle key, and the head of the line.
	 * @param {...string} extra Tail printed with the head; never keyed.
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

	// stderr → JS console (warn) + the bounded recentLog tail dmesg reads.
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
	 * counterpart of PHP Core::_stderr — callers that want Shell3's raw
	 * `print {*STDERR}` (no prefix, no recentLog tail) come straight here.
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
	 * @param {?number} [at] Seconds to stamp; defaults to now. A stored line
	 *                       prefixed at render passes the moment it was RECORDED, or a whole ring
	 *                       of them restamps to one render time.
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

	// Per-process identity for log_prefix (Perl $0 / PHP SAPI); fixed label.
	argv0() {
		return 'browser';
	}

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

	// Callers iterate this Map directly; keep it reachable.
	get nodes() {
		return this._registry.nodes;
	}

	// Bump full-rebuild signal: increment + notify every subscriber.
	bumpGraphGeneration() {
		this.graphGeneration++;
		for ( const listener of this._generationListeners ) {
			listener();
		}
	}

	// Subscribe to graphGeneration bumps; returns an unsubscribe function.
	subscribeGraphGeneration( listener ) {
		this._generationListeners.add( listener );
		return () => this._generationListeners.delete( listener );
	}

	// @longform
	// Distinct from graphGeneration on purpose: a BARE mountExospine() brings
	// the backbone up without bumping the generation (the console relies on
	// that, so a co-mounted overlay is not reinit'd), yet a passenger node
	// still has to learn the backbone exists. Generation means "rebuild what
	// you built"; backbone-up means "there is something to attach to".
	notifyBackboneUp() {
		this.backboneGeneration++;
		for ( const listener of this._backboneListeners ) {
			listener();
		}
	}

	// Subscribe to backbone-up notifications; returns an unsubscribe function.
	subscribeBackboneUp( listener ) {
		this._backboneListeners.add( listener );
		return () => this._backboneListeners.delete( listener );
	}

	registerNode( name, node ) {
		this._registry.registerNode( name, node );
	}

	unregisterNode( name ) {
		this._registry.unregisterNode( name );
	}

	// The registry a Node registers in unless it was given another.
	get registry() {
		return this._registry;
	}

	msgCounter() {
		this._msgCounter++;
		return this._msgCounter;
	}
}

// Back Core with a window singleton so every inlined bundle shares ONE graph.
const GLOBAL_KEY = '__newspackNodesCore';
if ( ! window[ GLOBAL_KEY ] ) {
	window[ GLOBAL_KEY ] = new CoreImpl();
}
export const Core = window[ GLOBAL_KEY ];
