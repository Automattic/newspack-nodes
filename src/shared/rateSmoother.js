/**
 * RateSmoother — windowed-average + EMA rate smoother.
 *
 * Aggregates observed counts into per-second buckets over a sliding window
 * (O(1) per add via a running total — no O(n) window scan), divides the window
 * total by the window length to get an average rate, then low-pass filters that
 * with an exponential moving average. This is the smoothing the Partition Viewer
 * lines/s readout uses; the overlay's live I/O counters share it so the two
 * read the same way and can't drift.
 *
 * Defaults: a 10-second window and a 0.1 EMA alpha.
 */
const DEFAULT_WINDOW_SEC = 10;
const DEFAULT_SMOOTHING = 0.1;

/**
 * Smooths a stream of observed counts into a steady per-second rate.
 *
 * Callers `add()` counts as they arrive and `read()` between arrivals; both
 * return the current smoothed rate, so a readout can be driven from either.
 */
export class RateSmoother {
	/**
	 * @param {number} windowSec Sliding-window length in seconds. The window
	 *                           total is divided by it to get the average rate.
	 * @param {number} smoothing EMA alpha: the fraction of the gap between that
	 *                           average and the current smoothed value each
	 *                           `add()` closes. Lower reacts more slowly.
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
	 * Return to a cold start: empty window, zero total, zero smoothed rate.
	 */
	reset() {
		// Per-second `{ sec, count }` buckets, a running total, the EMA rate.
		this.buckets = [];
		this.windowTotal = 0;
		this.smoothed = 0;
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
	 * Drop buckets older than the window from the running total.
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
	 * Read the current rate without folding anything into the window.
	 *
	 * Add-on-arrival feeders (the viewers' lps) freeze when the stream goes
	 * quiet: with no adds the window never expires and the readout holds its
	 * last value. Expiring here lets an idle stream's rate decay to zero over
	 * the window. The smoothed value snaps down to the window average and never
	 * up, so rises stay EMA-smooth while falls track the emptying window.
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
}
