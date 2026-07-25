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

export class RateSmoother {
	constructor(
		windowSec = DEFAULT_WINDOW_SEC,
		smoothing = DEFAULT_SMOOTHING
	) {
		this.windowSec = windowSec;
		this.smoothing = smoothing;
		this.reset();
	}

	reset() {
		// Per-second `{ sec, count }` buckets, a running total, the EMA rate.
		this.buckets = [];
		this.windowTotal = 0;
		this.smoothed = 0;
	}

	// Fold `count` at `nowMs` into the window; a negative count clamps to 0.
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

	// @longform Time-aware read for add-on-arrival feeders (the viewers' lps):
	// with no adds the window never expires and the readout freezes at its
	// last value. Expiring here lets an idle stream's rate decay to zero over
	// the window; snapping `smoothed` down (never up) keeps rises EMA-smooth
	// while falls track the emptying window.
	read( nowMs ) {
		this._expire( Math.floor( nowMs / 1000 ) );
		const rate = this.windowTotal / this.windowSec;
		if ( rate < this.smoothed ) {
			this.smoothed = rate;
		}
		return this.smoothed;
	}

	// Drop buckets older than the window from the running total.
	_expire( sec ) {
		const oldest = sec - this.windowSec;
		while ( this.buckets.length > 0 && this.buckets[ 0 ].sec <= oldest ) {
			this.windowTotal -= this.buckets[ 0 ].count;
			this.buckets.shift();
		}
	}
}
