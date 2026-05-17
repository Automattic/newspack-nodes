const PRINT_LESS_OFTEN_WINDOW_MS = 60_000;
const PRINT_LEAST_OFTEN_THRESHOLD = 10;

class CoreImpl {
	constructor() {
		this.reset();
	}

	reset() {
		this.nodes = new Map();
		this._msgCounter = 0;
		this._lastPrint = new Map(); // message → last-printed ms timestamp
		this._countSince = new Map(); // message → count since last print
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

	// Direct path: errors that are unlikely to repeat call this.
	// Browser substrate: stderr is the JS console. Use warn so messages
	// stand out from regular logging without triggering devtools' error
	// counter (errors imply a thrown exception).
	stderr( msg ) {
		// eslint-disable-next-line no-console
		console.warn( msg );
	}

	// Rate-limited: at most one print per identical message per 60s window.
	// Use for warnings that COULD repeat per-message in a hot path.
	printLessOften( msg ) {
		const now = Date.now();
		const last = this._lastPrint.get( msg ) ?? 0;
		if ( now - last < PRINT_LESS_OFTEN_WINDOW_MS ) {
			return;
		}
		this._lastPrint.set( msg, now );
		this.stderr( msg );
	}

	// Rate-limited: emits on every Nth occurrence and resets the counter.
	// Intentionally simpler than PHP `print_least_often`, which adds a 60s
	// squelch window after each emit. The browser-tab lifecycle and lower
	// message cardinality on the JS side don't need that extra guard — if
	// a tight loop on the browser side ever drowns the console, revisit.
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
