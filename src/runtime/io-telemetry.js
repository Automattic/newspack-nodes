/**
 * IoTelemetry — the browser runtime's I/O accounting singleton.
 *
 * The page's node graph crosses two boundaries to reach the server, and both
 * are counted here: inbound SSE frames and HTTP command responses accumulate
 * as "in", outbound HTTP command requests as "out". Four feeders write —
 * `SseInNode`, the command transport, `HttpOutNode` for wire error frames, and
 * `Core.stderr` for classified WARNING / ERROR / debug lines. Two surfaces
 * read: the debug overlay's Overview tab, and the topology console Inspector's
 * header when the graph on screen is the browser's own.
 *
 * The accumulator is per PAGE, not per node, because the feeders do not
 * outlive the readers. Boundary nodes are torn down and rebuilt on every tab
 * switch, and the live SSE node is anonymous and swaps between RemoteLinks, so
 * node-local counters would either zero themselves under the chart or become
 * unreachable from it.
 *
 * Cumulative counters last a page-load. Only the rate `series` reaches
 * localStorage, trimmed to a one-hour window, so the Overview charts still
 * carry history across a reload.
 *
 * Importing Core here is forbidden. Core imports this module to classify its
 * stderr lines, so the back edge would close a cycle; `nowSeconds()` inlines
 * the same clock instead.
 */

import { byteLength } from './message';

/**
 * UTF-8 byte length, re-exported so a boundary node takes its measure and its
 * counters from one import.
 */
export { byteLength };

/** Window property the one live `IoTelemetryImpl` is parked on. */
const GLOBAL_KEY = '__newspackNodesIoTelemetry';

/**
 * Wall clock in seconds, the same value `Core.now()` returns.
 *
 * Inlined rather than imported: Core already imports this module, and reaching
 * back for its clock would close the cycle.
 *
 * @return {number} Seconds since the epoch, fractional.
 */
function nowSeconds() {
	return Date.now() / 1000;
}

/** localStorage key holding the persisted rate series. */
const OVERVIEW_STORAGE_KEY = 'newspack-nodes:debug:overview';

/** Age bound on the rate series: one hour of history. */
const RING_SECONDS = 3600;

/**
 * Cadence the always-on sampler drives `sample()` at.
 *
 * Exported because the sampler and this module must agree on it: the row
 * spacing it sets is what `MAX_SAMPLES` sizes the ring from.
 */
export const SAMPLE_INTERVAL_MS = 5000;

/**
 * Length bound on the rate series — one hour at the sampler's cadence, 720
 * rows. Derived rather than written out, so moving either bound keeps the age
 * and length limits describing the same window.
 */
const MAX_SAMPLES = RING_SECONDS / ( SAMPLE_INTERVAL_MS / 1000 );

/**
 * Length bound on the ring of classified log lines. Per page-load, and never
 * persisted — the lines are a live tail, not history.
 */
const MAX_MESSAGES = 200;

/**
 * The accumulator: cumulative counters, the classified-line ring, the sampled
 * rate series, and the subscriber set the readers re-render on.
 *
 * Private to this module. Only the `IoTelemetry` singleton below escapes it,
 * so nothing can split the page's accounting across two instances.
 */
class IoTelemetryImpl {
	/**
	 * Initialize every field, then restore whatever series the last page-load
	 * persisted. `reset()` empties the series, so `load()` has to follow it.
	 */
	constructor() {
		this.reset();
		this.load( nowSeconds() );
	}

	/**
	 * Operator "reset stats": zero the counters, the classified lines and the
	 * rate series, and drop the persisted copy so a reload starts empty too.
	 *
	 * Subscribers survive, because the readers are still mounted and still
	 * watching. So does `sseConnectedAt`: clearing statistics does not
	 * disconnect the stream, and zeroing the stamp would make the Uptime card
	 * report a reconnect that never happened.
	 *
	 * @return {void}
	 */
	clear() {
		this.bytesIn = 0;
		this.bytesOut = 0;
		this.msgsIn = 0;
		this.msgsOut = 0;
		this.warnings = 0;
		this.errors = 0;
		this.debug = 0;
		this.messages = [];
		// Move the seq too, or a seq-keyed memo re-shows the cleared lines.
		this.messageSeq = ( this.messageSeq ?? 0 ) + 1;
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

	/**
	 * Count one warning, and append it when it carries text.
	 *
	 * @param {string} [text] The line as logged; empty adds no row.
	 * @return {void}
	 */
	recordWarning( text = '' ) {
		this.warnings++;
		this._pushMessage( 'warning', text );
	}

	/**
	 * Count `n` errors, and append `text` when it carries any.
	 *
	 * The count is a separate argument because an error can arrive with no
	 * text at all — a TM_ERROR frame carrying none still belongs on the card —
	 * and because a batch reply can fail more than once.
	 *
	 * @param {number} [n]    Errors to add.
	 * @param {string} [text] The line as logged; empty adds no row.
	 * @return {void}
	 */
	recordError( n = 1, text = '' ) {
		this.errors += n;
		this._pushMessage( 'error', text );
	}

	/**
	 * Count one debug line, and append it when it carries text.
	 *
	 * @param {string} [text] The line as logged; empty adds no row.
	 * @return {void}
	 */
	recordDebug( text = '' ) {
		this.debug++;
		this._pushMessage( 'debug', text );
	}

	/**
	 * Append one classified line to the ring, dropping the oldest at the cap.
	 *
	 * @param {string} level `warning`, `error` or `debug`.
	 * @param {string} text  The line; empty adds no row.
	 * @return {void}
	 */
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

	/**
	 * Append one rate row for `now`, then trim, persist and notify.
	 *
	 * The first call only seeds the baseline; every later call emits the
	 * cumulative delta divided by the elapsed seconds. A counter that moved
	 * backwards — a `clear()` between two samples — clamps to zero rather than
	 * emitting a negative rate. A non-positive elapsed time, from a clock
	 * stepped backwards or two samples inside one millisecond, re-seeds the
	 * baseline and emits nothing, because dividing by it yields infinity.
	 *
	 * @param {number} [now] Wall clock in seconds; defaults to this module's
	 *                       clock.
	 * @return {void}
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

	/**
	 * Run every subscriber.
	 *
	 * Reached from `sample()` and `clear()` only. Notifying per recorded
	 * message would re-render the readers on every SSE frame, so the cards
	 * poll `snapshot()` on their own faster tick instead.
	 *
	 * @return {void}
	 */
	_notify() {
		for ( const fn of this._listeners ) {
			fn();
		}
	}

	/**
	 * Write the rate series to localStorage.
	 *
	 * A disabled store or an exhausted quota costs the charts their history
	 * across the next reload and nothing else, so the failure is swallowed.
	 *
	 * @return {void}
	 */
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

	/**
	 * Bound the rate series by age, then by length.
	 *
	 * Both bounds earn their place: a clock stepped backwards leaves every row
	 * reading as recent, so the cutoff drops nothing and the cap is the only
	 * thing still bounding the array.
	 *
	 * @param {number} now Wall clock in seconds the cutoff counts back from.
	 * @return {void}
	 */
	_trim( now ) {
		const cutoff = now - RING_SECONDS;
		while ( this.series.length && this.series[ 0 ][ 0 ] < cutoff ) {
			this.series.shift();
		}
		while ( this.series.length > MAX_SAMPLES ) {
			this.series.shift();
		}
	}

	/**
	 * Re-initialize every field, subscribers and the SSE stamp included.
	 *
	 * This is the field list for the whole class — the constructor calls it
	 * rather than repeating it — and the JS suite calls it in `beforeEach`, so
	 * one test's counters cannot reach another's. It leaves localStorage
	 * alone, which is what lets a test seed the store and then call `load()`.
	 *
	 * @return {void}
	 */
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
		// Monotonic per-push seq — the message list's memo key.
		this.messageSeq = 0;
		// Compact rows: [ t, msgInRate, msgOutRate, byteInRate, byteOutRate ].
		this.series = [];
		// Monotonic sample counter — a stable, collision-free memo key.
		this.revision = 0;
		// Rate baseline (per page-load; null until the first sample).
		this._last = null;
		this._listeners = new Set();
	}

	/**
	 * Restore the persisted rate series, dropping rows past the one-hour
	 * window.
	 *
	 * Anything unreadable — a disabled store, malformed JSON, a stored value
	 * that is not an array — leaves the series as `reset()` left it. A broken
	 * stored value costs history, never the page's live accounting.
	 *
	 * @param {number} [now] Wall clock in seconds; defaults to this module's
	 *                       clock.
	 * @return {void}
	 */
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

	/**
	 * Accumulate one inbound arrival: SSE frame data, or a command response.
	 *
	 * @param {number} bytes   Wire bytes, from `byteLength()`.
	 * @param {number} [count] Messages the arrival carried.
	 * @return {void}
	 */
	recordIn( bytes, count = 1 ) {
		this.bytesIn += bytes;
		this.msgsIn += count;
	}

	/**
	 * Accumulate one outbound HTTP command request.
	 *
	 * @param {number} bytes   Request-body bytes, from `byteLength()`.
	 * @param {number} [count] Messages the request carried.
	 * @return {void}
	 */
	recordOut( bytes, count = 1 ) {
		this.bytesOut += bytes;
		this.msgsOut += count;
	}

	/**
	 * Stamp the moment the SSE stream connected, for the Uptime card.
	 *
	 * @param {number} [at] Wall clock in seconds; defaults to this module's
	 *                      clock.
	 * @return {void}
	 */
	markSseConnected( at = nowSeconds() ) {
		// Whole seconds: nowSeconds() is a float; avoid a fractional age.
		this.sseConnectedAt = Math.floor( at );
	}

	/**
	 * Drop the connect stamp, so the Uptime card reads as disconnected.
	 *
	 * @return {void}
	 */
	markSseDisconnected() {
		this.sseConnectedAt = null;
	}

	/**
	 * Read the counters as a plain object, for one render pass.
	 *
	 * `messages` is copied so a reader cannot mutate the ring, which makes the
	 * copy a fresh array every call and therefore useless as a memo key. Key
	 * on `messageSeq`, which moves once per appended line and once per
	 * `clear()`.
	 *
	 * @return {{bytesIn:number,bytesOut:number,msgsIn:number,msgsOut:number,warnings:number,errors:number,debug:number,sseConnectedAt:number|null,messages:Array<{level:string,text:string,ts:number}>,messageSeq:number}}
	 *   The cumulative counters, the SSE connect stamp, and the classified
	 *   lines with the seq to key them on.
	 */
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

	/**
	 * The rate series itself, not a copy.
	 *
	 * `sample()` appends in place, so the array identity never changes and a
	 * memo keyed on it would never invalidate; key on `revision`, which moves
	 * once per appended row. Treat the rows as read-only.
	 *
	 * @return {Array<Array<number>>} Rows of `[ t, msgInRate, msgOutRate,
	 *   byteInRate, byteOutRate ]` — `t` a whole-second wall clock, the four
	 *   rates per second.
	 */
	getSeries() {
		return this.series;
	}

	/**
	 * Register a change listener, run on each `sample()` and each `clear()`.
	 *
	 * @param {() => void} fn Called with no arguments when the store changes.
	 * @return {() => void} Unsubscribe.
	 */
	subscribe( fn ) {
		this._listeners.add( fn );
		return () => this._listeners.delete( fn );
	}
}

if ( ! window[ GLOBAL_KEY ] ) {
	window[ GLOBAL_KEY ] = new IoTelemetryImpl();
}

/**
 * The one I/O accumulator for this page.
 *
 * The console, the debug overlay and each dashboard inline their own copy of
 * this module, so a module-scoped instance would give every bundle private
 * counters and leave each chart drawing a fraction of the page's traffic.
 * Parking the instance on `window` is what makes them one accumulator.
 */
export const IoTelemetry = window[ GLOBAL_KEY ];
