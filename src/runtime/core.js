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
		this.initTime = this.now(); // uptime baseline (mirrors PHP Core::$init_time)
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

	node( name ) {
		return this.nodes.get( name ) ?? null;
	}

	now() {
		return Date.now() / 1000;
	}

	msgCounter() {
		this._msgCounter += 1;
		return this._msgCounter;
	}

	// Per-process identity for log_prefix (Perl $0 / PHP SAPI). The browser has
	// no SAPI; a fixed label keeps dmesg lines attributable.
	argv0() {
		return 'newspack-nodes';
	}

	// Core mid-line tag (Tachikoma Node::log_midfix). Core is process-global with
	// no node name, so the tag is empty: null → '', else the message chomped + one
	// trailing newline. (The per-node `{name}: ` tag lives on Node, which has a name.)
	log_midfix( msg = null ) {
		if ( null === msg || undefined === msg ) {
			return '';
		}
		return msg.replace( /\n+$/, '' ) + '\n';
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

	// stderr = the JS console (warn, not error, to skip devtools' error counter) +
	// the bounded recentLog tail the dmesg verb reads. A line already starting with
	// a date is passed through verbatim (no double-prefix on a re-log); otherwise
	// apply prefix + midfix like PHP Core::stderr.
	stderr( text ) {
		if ( '' === text || null === text || undefined === text ) {
			return;
		}
		const line = /^\d{4}-\d\d-\d\d/.test( text )
			? text.replace( /\n+$/, '' ) + '\n'
			: this.log_prefix( this.log_midfix( text ) );
		this.recentLog.push( line );
		while ( this.recentLog.length > RECENT_LOG_MAX ) {
			this.recentLog.shift();
		}
		// eslint-disable-next-line no-console
		console.warn( line.replace( /\n$/, '' ) );
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
}

export const Core = new CoreImpl();
