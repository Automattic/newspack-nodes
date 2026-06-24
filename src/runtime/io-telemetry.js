/**
 * IoTelemetry — the debug overlay's I/O accounting singleton. The browser-side
 * graph talks to the server over two boundaries: inbound SSE frames + HTTP
 * command responses ("in"), and outbound HTTP command requests ("out"). The
 * boundary nodes (SseConnector, CommandClient) and Core.stderr feed cumulative
 * counters here; the Overview tab reads them.
 *
 * Why a window singleton (like Core / the devtools tab registry): the boundary
 * nodes get torn down + rebuilt on tab switches and the live SSE node is
 * anonymous and swaps between RemoteLinks — node-local counters would reset or
 * be unreachable. A per-page accumulator survives all of that. The cumulative
 * totals are per page-load; only the rate `series` is persisted to localStorage
 * (trimmed to a 1-hour window) so the chart carries history across reloads.
 *
 * sample() is a pure-ish reducer (now passed in): it computes per-second rates
 * from the delta since the previous sample, appends one compact
 * `[ t, msgInRate, msgOutRate, byteInRate, byteOutRate ]` row, trims, persists,
 * and notifies subscribers. The always-on sampler (started by DebugOverlay)
 * calls it every 5s.
 *
 * It deliberately does NOT import Core: Core.stderr imports IoTelemetry to
 * classify WARNING:/ERROR: lines, so a back-dependency here would be a cycle. Its
 * own clock (matching Core.now()) keeps the module self-contained.
 */

import { byteLength } from './message';

// Re-exported so the boundary instrumentation (SseConnector, CommandClient) can
// pull the byte counter from the same module it records into.
export { byteLength };

const GLOBAL_KEY = '__newspackNodesIoTelemetry';

// Seconds clock, identical to Core.now() — inlined to avoid importing Core.
function nowSeconds() {
	return Date.now() / 1000;
}

export const OVERVIEW_STORAGE_KEY = 'newspack-nodes:debug:overview';
// 1-hour rolling window at a 5-second cadence = 720 samples.
export const RING_SECONDS = 3600;
export const SAMPLE_INTERVAL_MS = 5000;
export const MAX_SAMPLES = RING_SECONDS / ( SAMPLE_INTERVAL_MS / 1000 );
// Bounded ring of the most recent classified log lines (debug/warning/error)
// shown under the Overview charts — per page-load, not persisted.
export const MAX_MESSAGES = 200;

class IoTelemetryImpl {
	constructor() {
		this.reset();
		this.load( nowSeconds() );
	}

	// Clear every counter + the series + subscribers. Does NOT touch localStorage
	// (so tests stay isolated) — load() restores from storage explicitly.
	reset() {
		this.bytesIn = 0;
		this.bytesOut = 0;
		this.msgsIn = 0;
		this.msgsOut = 0;
		this.warnings = 0;
		this.errors = 0;
		this.debug = 0;
		// Recent classified log lines `{ level, text, ts }` (bounded ring).
		this.messages = [];
		// Compact rows: [ t, msgInRate, msgOutRate, byteInRate, byteOutRate ].
		this.series = [];
		// Monotonic emitted-sample counter — a stable, collision-free memo key for
		// readers (the in-place ring mutates, so length/last-ts is a fragile proxy).
		this.revision = 0;
		// Rate baseline (per page-load; null until the first sample).
		this._last = null;
		this._listeners = new Set();
	}

	// Operator "reset stats": zero the counters, series, and messages AND drop the
	// persisted series — but KEEP subscribers (the dashboards stay live and
	// re-render to the cleared state). Bumps the revision so the chart memo
	// recomputes against the empty series, and restarts the rate baseline.
	clear() {
		this.bytesIn = 0;
		this.bytesOut = 0;
		this.msgsIn = 0;
		this.msgsOut = 0;
		this.warnings = 0;
		this.errors = 0;
		this.debug = 0;
		this.messages = [];
		this.series = [];
		this.revision += 1;
		this._last = null;
		try {
			window.localStorage.removeItem( OVERVIEW_STORAGE_KEY );
		} catch ( _e ) {
			// localStorage disabled — the in-memory clear is enough.
		}
		this._notify();
	}

	recordIn( bytes, count = 1 ) {
		this.bytesIn += bytes;
		this.msgsIn += count;
	}

	recordOut( bytes, count = 1 ) {
		this.bytesOut += bytes;
		this.msgsOut += count;
	}

	recordWarning( text = '' ) {
		this.warnings += 1;
		this._pushMessage( 'warning', text );
	}

	recordError( n = 1, text = '' ) {
		this.errors += n;
		this._pushMessage( 'error', text );
	}

	recordDebug( text = '' ) {
		this.debug += 1;
		this._pushMessage( 'debug', text );
	}

	// Append a classified line to the bounded ring. A textless record (e.g. a
	// TM_ERROR frame) bumps the counter but adds no row. No notify: the list
	// refreshes on the next sampler tick like the count cards, not per line.
	_pushMessage( level, text ) {
		if ( '' === text ) {
			return;
		}
		this.messages.push( { level, text, ts: nowSeconds() } );
		while ( this.messages.length > MAX_MESSAGES ) {
			this.messages.shift();
		}
	}

	snapshot() {
		return {
			bytesIn: this.bytesIn,
			bytesOut: this.bytesOut,
			msgsIn: this.msgsIn,
			msgsOut: this.msgsOut,
			warnings: this.warnings,
			errors: this.errors,
			debug: this.debug,
			messages: this.messages.slice(),
		};
	}

	getSeries() {
		return this.series;
	}

	subscribe( fn ) {
		this._listeners.add( fn );
		return () => this._listeners.delete( fn );
	}

	/**
	 * Append a rate sample for `now` (seconds). The first call only seeds the
	 * baseline; subsequent calls emit `Δcumulative / Δt`, trim the ring, persist,
	 * and notify. A non-positive dt (clock skew) is skipped.
	 *
	 * @param {number} [now] Wall clock in seconds (default Core.now()).
	 */
	sample( now = nowSeconds() ) {
		const cur = {
			t: now,
			bytesIn: this.bytesIn,
			bytesOut: this.bytesOut,
			msgsIn: this.msgsIn,
			msgsOut: this.msgsOut,
		};
		if ( this._last ) {
			const dt = cur.t - this._last.t;
			if ( dt > 0 ) {
				const rate = ( a, b ) => Math.max( 0, ( a - b ) / dt );
				this.series.push( [
					Math.round( cur.t ),
					rate( cur.msgsIn, this._last.msgsIn ),
					rate( cur.msgsOut, this._last.msgsOut ),
					rate( cur.bytesIn, this._last.bytesIn ),
					rate( cur.bytesOut, this._last.bytesOut ),
				] );
				this.revision += 1;
				this._trim( cur.t );
				this._persist();
				this._notify();
			}
		}
		this._last = cur;
	}

	// Drop rows older than the 1h window, then cap to MAX_SAMPLES (oldest first).
	_trim( now ) {
		const cutoff = now - RING_SECONDS;
		while ( this.series.length && this.series[ 0 ][ 0 ] < cutoff ) {
			this.series.shift();
		}
		while ( this.series.length > MAX_SAMPLES ) {
			this.series.shift();
		}
	}

	_notify() {
		for ( const fn of this._listeners ) {
			fn();
		}
	}

	_persist() {
		try {
			window.localStorage.setItem(
				OVERVIEW_STORAGE_KEY,
				JSON.stringify( this.series )
			);
		} catch ( _e ) {
			// localStorage disabled / quota — in-session only.
		}
	}

	// Restore the persisted series, dropping rows older than the 1h window.
	// Malformed storage is ignored (series stays empty).
	load( now = nowSeconds() ) {
		let stored;
		try {
			stored = JSON.parse(
				window.localStorage.getItem( OVERVIEW_STORAGE_KEY ) || '[]'
			);
		} catch ( _e ) {
			return;
		}
		if ( ! Array.isArray( stored ) ) {
			return;
		}
		const cutoff = now - RING_SECONDS;
		this.series = stored.filter(
			( row ) => Array.isArray( row ) && row[ 0 ] >= cutoff
		);
	}
}

// The build emits each dashboard bundle as its own IIFE inlining its own copy of
// this module; a module-local instance would split the accounting per bundle. Back
// it with a process-wide window singleton so every copy shares ONE accumulator —
// matching the Core / tabRegistry convention. Bare `window` is safe: these bundles
// only run in the browser (jest provides window too).
if ( ! window[ GLOBAL_KEY ] ) {
	window[ GLOBAL_KEY ] = new IoTelemetryImpl();
}

export const IoTelemetry = window[ GLOBAL_KEY ];
