/**
 * Windowed-average + EMA rate smoother, behind every live per-second readout.
 *
 * A raw delta between two samples reads as a burst or a zero, never as a rate.
 * So counts land in per-second buckets over a sliding window, the window total
 * divided by the window length gives an average, and an exponential moving
 * average low-pass filters that average into a figure steady enough to read.
 *
 * `LogStreamViewNode` drives its lines/s from one, so every log-stream
 * dashboard — Partition Viewer, Log Viewer, and downstream adopters like ELN's
 * Request Log — smooths alike; the debug overlay's Overview cards drive their
 * byte and message In/Out rates from four more. Sharing the arithmetic is what
 * keeps two readouts of the same traffic from disagreeing.
 *
 * The window is a running total, not a scan: an add folds its own count in and
 * subtracts whatever fell out the back, and the bucket list holds at most one
 * entry per second of the window.
 */

/**
 * Default sliding-window length in seconds. A longer window averages over more
 * history, so any one second's traffic moves the rate less.
 */
const DEFAULT_WINDOW_SEC = 10;

/**
 * Default EMA alpha: the fraction of the gap between the window average and
 * the smoothed value that each `add()` closes.
 */
const DEFAULT_SMOOTHING = 0.1;

/**
 * Smooths a stream of observed counts into a steady per-second rate.
 *
 * Callers `add()` counts as they arrive and `read()` between arrivals; both
 * return the current smoothed rate, so a readout can be driven from either.
 */
export class RateSmoother {
	/**
	 * @param {number} [windowSec] Sliding-window length in seconds. The window
	 *                             total is divided by it to get the average
	 *                             rate. Defaults to 10.
	 * @param {number} [smoothing] EMA alpha: the fraction of the gap between
	 *                             that average and the current smoothed value
	 *                             each `add()` closes. Lower reacts more
	 *                             slowly. Defaults to 0.1.
	 */
	constructor(
		windowSec = DEFAULT_WINDOW_SEC,
		smoothing = DEFAULT_SMOOTHING
	) {
		this.windowSec = windowSec;
		this.smoothing = smoothing;
		this.reset();
	}

	/**
	 * Fold a count into the window and advance the smoothed rate.
	 *
	 * @param {number} count Events observed since the last call. A negative
	 *                       count — a counter reset — clamps to 0.
	 * @param {number} nowMs Observation time, epoch milliseconds.
	 * @return {number} The smoothed rate, in events per second.
	 */
	add( count, nowMs ) {
		const n = count > 0 ? count : 0;
		const sec = Math.floor( nowMs / 1000 );
		const last = this.buckets[ this.buckets.length - 1 ];
		if ( last && last.sec === sec ) {
			last.count += n;
		} else {
			this.buckets.push( { sec, count: n } );
		}
		this.windowTotal += n;
		this._expire( sec );
		const rate = this.windowTotal / this.windowSec;
		this.smoothed += ( rate - this.smoothed ) * this.smoothing;
		return this.smoothed;
	}

	/**
	 * Read the current rate without folding anything into the window.
	 *
	 * Add-on-arrival feeders like the lines/s readout freeze when the stream
	 * goes quiet: with no adds the window never expires and the readout holds
	 * its last value. Expiring here lets an idle stream's rate decay to zero
	 * over the window. The smoothed value snaps down to the window average and
	 * never up, so rises stay EMA-smooth while falls track the emptying window.
	 *
	 * @param {number} nowMs Read time, epoch milliseconds.
	 * @return {number} The smoothed rate, in events per second.
	 */
	read( nowMs ) {
		this._expire( Math.floor( nowMs / 1000 ) );
		const rate = this.windowTotal / this.windowSec;
		if ( rate < this.smoothed ) {
			this.smoothed = rate;
		}
		return this.smoothed;
	}

	/**
	 * Drop buckets older than the window from the list and the running total.
	 *
	 * A bucket leaves at `sec - windowSec`, so the window covers the whole
	 * trailing `windowSec` seconds and no more. Both `add()` and `read()` call
	 * this, which is what lets a rate decay with no traffic behind it.
	 *
	 * @param {number} sec Current time, floored to whole seconds.
	 */
	_expire( sec ) {
		const oldest = sec - this.windowSec;
		while ( this.buckets.length > 0 && this.buckets[ 0 ].sec <= oldest ) {
			this.windowTotal -= this.buckets[ 0 ].count;
			this.buckets.shift();
		}
	}

	/**
	 * Return to a cold start: empty window, zero total, zero smoothed rate.
	 *
	 * A feeder whose source counter can rewind calls this on the rewind — the
	 * overlay does, on a telemetry reset. A negative delta clamps to zero, so
	 * without the reset the pre-reset counts sit in the window and keep
	 * reporting a rate for a further `windowSec` seconds.
	 */
	reset() {
		/** @type {Array<{sec:number,count:number}>} Per-second count buckets. */
		this.buckets = [];
		this.windowTotal = 0;
		this.smoothed = 0;
	}
}
