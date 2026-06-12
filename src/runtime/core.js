import { newMessage, TYPE, TIMESTAMP, VALUE, TM_BYTESTREAM } from './message';
import names from './reserved-node-names.json';

const PRINT_LESS_OFTEN_WINDOW_MS = 60_000;
const PRINT_LEAST_OFTEN_THRESHOLD = 10;
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
		this.initTime = this.now(); // uptime baseline (mirrors PHP Core::$init_time)
		this.reinit = null; // current page graph's rebuild handle (set by mountExospine, cleared on teardown)
		this.reinitNames = null; // names mountExospine's build registered (the reinit-managed set)
		// Full-graph rebuild signal: bumping it re-runs every graph-building React
		// effect (each dashboard hook's mountExospine + the overlay's useDebugRepl),
		// so its cleanup tears down its nodes and its effect rebuilds them — a
		// page-reload-in-place. The overlay's "Reset Graph" removes every node then
		// bumps this to reconstruct the entire graph.
		this.graphGeneration = 0;
		this._generationListeners = new Set();
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

	// stderr = the JS console (warn, not error, to skip devtools' error counter) +
	// the bounded recentLog tail the dmesg verb reads. A line already starting with
	// a date is passed through verbatim (no double-prefix on a re-log); otherwise
	// apply prefix like PHP Core::stderr.
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
		console.warn( line.replace( /\n$/, '' ) );
		// Also surface at the REPL: fan the formatted line to whichever reply sink
		// this graph wired — `_repl` (worker output partition) else `_output` (the
		// Dumper). Guarded so a fault inside the sink's fill can't recurse forever.
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

	// Prepend a `YYYY-MM-DD HH:MM:SS UTC <argv0>: ` prefix to every line — mirrors
	// PHP Core::log_prefix minus hostname + pid (neither is available in-browser).
	// null → the bare prefix; a message → each line prefixed, chomped, + one newline.
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

	// Per-process identity for log_prefix (Perl $0 / PHP SAPI). The browser has
	// no SAPI; a fixed label keeps dmesg lines attributable.
	argv0() {
		return 'browser';
	}

	node( name ) {
		return this.nodes.get( name ) ?? null;
	}

	// Emits on every Nth occurrence, then resets the counter.
	printLeastOften( msg ) {
		const n = ( this._countSince.get( msg ) ?? 0 ) + 1;
		if ( n < PRINT_LEAST_OFTEN_THRESHOLD ) {
			this._countSince.set( msg, n );
			return;
		}
		this._countSince.set( msg, 0 );
		this.stderr( msg );
	}

	// Bump the full-rebuild signal: increment + notify every subscriber so each
	// graph-building effect re-runs (tears down + rebuilds its nodes).
	bumpGraphGeneration() {
		this.graphGeneration += 1;
		for ( const listener of this._generationListeners ) {
			listener();
		}
	}

	// Subscribe to graphGeneration bumps (used by useGraphGeneration). Returns an
	// unsubscribe function.
	subscribeGraphGeneration( listener ) {
		this._generationListeners.add( listener );
		return () => this._generationListeners.delete( listener );
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
		this._msgCounter += 1;
		return this._msgCounter;
	}
}

export const Core = new CoreImpl();
