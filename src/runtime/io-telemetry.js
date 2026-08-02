/**
 * IoTelemetry — the debug overlay's I/O accounting singleton. The browser-side
 * graph talks to the server over two boundaries: inbound SSE frames + HTTP
 * command responses ("in"), and outbound HTTP command requests ("out"). The
 * boundary nodes (SseIn, CommandClient) and Core.stderr feed cumulative
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

// Re-exported so SseIn/CommandClient pull byteLength from this module.
export { byteLength };

const GLOBAL_KEY = '__newspackNodesIoTelemetry';

// Seconds clock, identical to Core.now() — inlined to avoid importing Core.
function nowSeconds() {
	return Date.now() / 1000;
}

const OVERVIEW_STORAGE_KEY = 'newspack-nodes:debug:overview';
// 1-hour rolling window at a 5-second cadence = 720 samples.
const RING_SECONDS = 3600;
export const SAMPLE_INTERVAL_MS = 5000;
const MAX_SAMPLES = RING_SECONDS / ( SAMPLE_INTERVAL_MS / 1000 );
// Bounded ring of recent classified log lines — per page-load, not persisted.
const MAX_MESSAGES = 200;

class IoTelemetryImpl {
	constructor() {
		this.reset();
		this.load( nowSeconds() );
	}

	// Clear counters + series + subscribers; does NOT touch localStorage.
	reset() {
		this.bytesIn = 0;
		this.bytesOut = 0;
		this.msgsIn = 0;
		this.msgsOut = 0;
		this.warnings = 0;
		this.errors = 0;
		this.debug = 0;
		// Wall-clock (s) the SSE stream last connected, else null.
		this.sseConnectedAt = null;
		// Recent classified log lines `{ level, text, ts }` (bounded ring).
		this.messages = [];
		// Compact rows: [ t, msgInRate, msgOutRate, byteInRate, byteOutRate ].
		this.series = [];
		// Monotonic sample counter — a stable, collision-free memo key.
		this.revision = 0;
		// Rate baseline (per page-load; null until the first sample).
		this._last = null;
		this._listeners = new Set();
	}

	// Restore the persisted series (drop rows >1h; malformed → empty).
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

	// Operator "reset stats": zero counters/series/messages, KEEP subscribers.
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
		this.revision++;
		this._last = null;
		try {
			window.localStorage.removeItem( OVERVIEW_STORAGE_KEY );
		} catch ( _e ) {
			// localStorage disabled — the in-memory clear is enough.
		}
		this._notify();
	}

	_notify() {
		for ( const fn of this._listeners ) {
			fn();
		}
	}

	recordWarning( text = '' ) {
		this.warnings++;
		this._pushMessage( 'warning', text );
	}

	// Append a classified line to the bounded ring; textless adds no row.
	_pushMessage( level, text ) {
		if ( '' === text ) {
			return;
		}
		// Monotonic per-push seq: a stable memo key even for same-ms bursts.
		this.messageSeq = ( this.messageSeq ?? 0 ) + 1;
		this.messages.push( { level, text, ts: nowSeconds() } );
		while ( this.messages.length > MAX_MESSAGES ) {
			this.messages.shift();
		}
	}

	recordError( n = 1, text = '' ) {
		this.errors += n;
		this._pushMessage( 'error', text );
	}

	recordDebug( text = '' ) {
		this.debug++;
		this._pushMessage( 'debug', text );
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
				this.revision++;
				this._trim( cur.t );
				this._persist();
				this._notify();
			}
		}
		this._last = cur;
	}

	// Drop rows older than the 1h window, then cap to MAX_SAMPLES.
	_trim( now ) {
		const cutoff = now - RING_SECONDS;
		while ( this.series.length && this.series[ 0 ][ 0 ] < cutoff ) {
			this.series.shift();
		}
		while ( this.series.length > MAX_SAMPLES ) {
			this.series.shift();
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

	recordIn( bytes, count = 1 ) {
		this.bytesIn += bytes;
		this.msgsIn += count;
	}

	recordOut( bytes, count = 1 ) {
		this.bytesOut += bytes;
		this.msgsOut += count;
	}

	// SSE lifecycle (Overview Uptime card); connect stamps, disconnect clears.
	markSseConnected( at = nowSeconds() ) {
		// Whole seconds: nowSeconds() is a float; avoid a fractional age.
		this.sseConnectedAt = Math.floor( at );
	}

	markSseDisconnected() {
		this.sseConnectedAt = null;
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
			sseConnectedAt: this.sseConnectedAt,
			messages: this.messages.slice(),
			messageSeq: this.messageSeq ?? 0,
		};
	}

	getSeries() {
		return this.series;
	}

	subscribe( fn ) {
		this._listeners.add( fn );
		return () => this._listeners.delete( fn );
	}
}

// Back with a window singleton so every inlined bundle shares ONE accumulator.
if ( ! window[ GLOBAL_KEY ] ) {
	window[ GLOBAL_KEY ] = new IoTelemetryImpl();
}

export const IoTelemetry = window[ GLOBAL_KEY ];
