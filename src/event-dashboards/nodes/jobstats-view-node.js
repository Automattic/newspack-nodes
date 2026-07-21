import { ProbeStreamViewNode } from './probe-stream-view-node';
import {
	KEY,
	HANDLER,
	RUNS,
	ERRORS,
	DURATION_MS,
	QUEUE_MS,
	ITEMS_OK,
	ITEMS_ERR,
	LAST_TS,
	LAST_DURATION_MS,
	LAST_STATUS,
	LAST_MESSAGE,
} from '../../runtime/jobstats-record';

/**
 * `jobstats:view` — owns the Jobstats stream view model.
 *
 * Each inbound frame is one job identity's lean POSITIONAL record (the
 * `Jobstats_Record` layout); the snapshot instant is the Message TIMESTAMP. The
 * view accumulates, PER identity `KEY`, a bounded series of `{ ts, runsRate,
 * errorsRate, itemsRate }` DERIVED from consecutive cumulative counters (Δ/Δ ts) —
 * a worker restart (counter reset) or the first sample yields rate 0, never
 * negative — plus the LATEST cumulative + last-run detail for the per-handler
 * table. Shares ProbeStreamViewNode's ring/throttle/TTL machinery; supplies only
 * the KEY identity + the jobstats field mapping.
 *
 * @param {number} [maxSamples] Per-identity ring cap.
 * @param {number} [ttlMs]      Identity liveness TTL.
 */
export class JobstatsViewNode extends ProbeStreamViewNode {
	constructor( maxSamples, ttlMs ) {
		super( maxSamples, ttlMs );
		this.modelKey = 'handlers';
	}

	_identityOf( value ) {
		return value[ KEY ];
	}

	_accumulate( key, value, ts ) {
		if ( this._isExpired( ts ) ) {
			return;
		}
		let c = this.entries[ key ];
		if ( ! c ) {
			c = {
				handler: '',
				series: [],
				_lastRuns: null,
				_lastErrors: null,
				_lastItems: null,
				_lastTs: 0,
				_lastSeen: 0,
			};
			this.entries[ key ] = c;
		}
		c._lastSeen = Date.now();
		c.handler = String( value[ HANDLER ] ?? c.handler );

		const runs = Number( value[ RUNS ] ) || 0;
		const errors = Number( value[ ERRORS ] ) || 0;
		const items = Number( value[ ITEMS_OK ] ) || 0;
		// Latest cumulative + last-run detail (the table reads these verbatim).
		c.runs = runs;
		c.errors = errors;
		c.durationMs = Number( value[ DURATION_MS ] ) || 0;
		c.queueMs = Number( value[ QUEUE_MS ] ) || 0;
		c.itemsOk = items;
		c.itemsErr = Number( value[ ITEMS_ERR ] ) || 0;
		c.lastTs = Number( value[ LAST_TS ] ) || 0;
		c.lastDurationMs = Number( value[ LAST_DURATION_MS ] ) || 0;
		c.lastStatus = String( value[ LAST_STATUS ] || '' );
		c.lastMessage = String( value[ LAST_MESSAGE ] || '' );

		// Rates from consecutive records (Δ/Δts); a reset (Δ<0) → 0.
		const dt = ts > c._lastTs ? ts - c._lastTs : 0;
		const runsRate = this._rate( c._lastRuns, runs, dt );
		const errorsRate = this._rate( c._lastErrors, errors, dt );
		const itemsRate = this._rate( c._lastItems, items, dt );
		c._lastRuns = runs;
		c._lastErrors = errors;
		c._lastItems = items;
		c._lastTs = ts;

		c.series.push( { ts, runsRate, errorsRate, itemsRate } );
		this._capSeries( c.series );
	}

	// Δcounter/Δts, never negative; a null prior or a reset yields 0.
	_rate( prior, current, dt ) {
		return null !== prior && dt > 0 && current >= prior
			? ( current - prior ) / dt
			: 0;
	}

	_entryView( c ) {
		return {
			handler: c.handler,
			latest: {
				runs: c.runs,
				errors: c.errors,
				avgDurationMs: c.runs > 0 ? c.durationMs / c.runs : 0,
				avgQueueMs: c.runs > 0 ? c.queueMs / c.runs : 0,
				itemsOk: c.itemsOk,
				itemsErr: c.itemsErr,
				lastTs: c.lastTs,
				lastDurationMs: c.lastDurationMs,
				lastStatus: c.lastStatus,
				lastMessage: c.lastMessage,
			},
			// Copy, not the live ref (else memo freezes + tears mid-burst).
			series: c.series.slice(),
		};
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Jobstats stream render-model sink (the React view node).',
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
