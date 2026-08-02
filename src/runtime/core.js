import { newMessage, TYPE, TIMESTAMP, VALUE, TM_BYTESTREAM } from './message';
import names from './reserved-node-names.json';
import { IoTelemetry } from './io-telemetry';

const PRINT_LESS_OFTEN_WINDOW_MS = 60_000;
// Bounded stderr tail for the dmesg verb (Tachikoma caps @RECENT_LOG at 100).
const RECENT_LOG_MAX = 100;

class CoreImpl {
	constructor() {
		this.reset();
	}

	reset() {
		this.nodes = new Map();
		this._msgCounter = 0;
		this._lastPrint = new Map(); // message → last-printed ms timestamp
		this._countSince = new Map(); // message → count since last print
		this.recentLog = []; // bounded stderr tail for the dmesg verb
		this._inStderr = false; // re-entry guard for the stderr reply-sink emit
		this.initTime = this.now(); // uptime baseline (PHP Core::$init_time)
		this.rebuildable = false; // overlay Reset-Graph capability; mountExospine sets it
		this.backboneOwned = false; // a non-passenger mount holds the backbone
		this.reinitNames = null; // names mountExospine's build registered
		// Full-graph rebuild signal: bumping re-runs every graph effect.
		this.graphGeneration = 0;
		// Bumped when a mount CREATES the backbone (bare or delegated).
		this.backboneGeneration = 0;
		this._generationListeners = new Set();
		this._backboneListeners = new Set();
	}

	now() {
		return Date.now() / 1000;
	}

	// At most one print per identical message per 60s window.
	printLessOften( msg ) {
		const now = Date.now();
		const last = this._lastPrint.get( msg ) ?? 0;
		if ( now - last < PRINT_LESS_OFTEN_WINDOW_MS ) {
			return;
		}
		this._lastPrint.set( msg, now );
		this.stderr( msg );
	}

	// stderr → JS console (warn) + the bounded recentLog tail dmesg reads.
	stderr( text ) {
		if ( '' === text || null === text || undefined === text ) {
			return;
		}
		const line = /^\d{4}-\d\d-\d\d/.test( text )
			? text.replace( /\n+$/, '' ) + '\n'
			: this.log_prefix( text );
		this.recentLog.push( line );
		while ( this.recentLog.length > RECENT_LOG_MAX ) {
			this.recentLog.shift();
		}
		this._stderr( line );
	}

	// Prepend a `YYYY-MM-DD HH:MM:SS UTC <argv0>: ` prefix to every line.
	log_prefix( msg = null ) {
		const ts = new Date( this.now() * 1000 )
			.toISOString()
			.slice( 0, 19 )
			.replace( 'T', ' ' );
		const prefix = `${ ts } UTC ${ this.argv0() }: `;
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
		return this.nodes.get( name ) ?? null;
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
		if ( this.nodes.has( name ) ) {
			throw new Error(
				`node name collision: ${ name } already registered`
			);
		}
		this.nodes.set( name, node );
	}

	unregisterNode( name ) {
		this.nodes.delete( name );
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
