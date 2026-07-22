import { JobstatsViewNode } from '../jobstats-view-node';
import { RETENTION_S } from '../probe-stream-view-node';
import {
	newMessage,
	TYPE,
	TIMESTAMP,
	VALUE,
	TM_STRUCT,
} from '../../../runtime/message';
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
} from '../../../runtime/jobstats-record';

// Probe ts is an OFFSET from a recent epoch base so records stay in the 24h window.
const TS_BASE = Math.floor( Date.now() / 1000 ) - 10000;

// Build a jobstats TM_STRUCT frame: positional VALUE, sweep instant in TIMESTAMP.
function jobstatsMsg( {
	ts = 1000,
	key = 'evtemplate',
	handler = 'evtemplate',
	runs = 0,
	errors = 0,
	durationMs = 0,
	queueMs = 0,
	itemsOk = 0,
	itemsErr = 0,
	lastTs = 0,
	lastDurationMs = 0,
	lastStatus = 'success',
	lastMessage = 'Job completed successfully',
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = TS_BASE + ts;
	const v = [];
	v[ KEY ] = key;
	v[ HANDLER ] = handler;
	v[ RUNS ] = runs;
	v[ ERRORS ] = errors;
	v[ DURATION_MS ] = durationMs;
	v[ QUEUE_MS ] = queueMs;
	v[ ITEMS_OK ] = itemsOk;
	v[ ITEMS_ERR ] = itemsErr;
	v[ LAST_TS ] = lastTs;
	v[ LAST_DURATION_MS ] = lastDurationMs;
	v[ LAST_STATUS ] = lastStatus;
	v[ LAST_MESSAGE ] = lastMessage;
	m[ VALUE ] = v;
	return m;
}

describe( 'JobstatsViewNode', () => {
	it( 'indexes handlers by identity key, carrying the handler name', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { key: 'cron:films', handler: 'cron' } ) );
		v.fill( jobstatsMsg( { key: 'evtemplate', handler: 'evtemplate' } ) );
		const snap = v.snapshot();
		expect( Object.keys( snap ).sort() ).toEqual( [
			'cron:films',
			'evtemplate',
		] );
		expect( snap[ 'cron:films' ].handler ).toBe( 'cron' );
	} );

	it( 'computes runs-rate from consecutive RUNS deltas over the ts gap', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 10, ts: 100 } ) );
		v.fill( jobstatsMsg( { runs: 40, ts: 103 } ) ); // +30 runs / 3s
		expect( v.snapshot().evtemplate.series.at( -1 ).runsRate ).toBe( 10 );
	} );

	it( 'computes errors-rate from consecutive ERRORS deltas over the ts gap', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { errors: 2, ts: 100 } ) );
		v.fill( jobstatsMsg( { errors: 8, ts: 103 } ) ); // +6 / 3s
		expect( v.snapshot().evtemplate.series.at( -1 ).errorsRate ).toBe( 2 );
	} );

	it( 'counts a RUNS reset (worker restart) as the new generation runs, never negative', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 9000, ts: 100 } ) );
		v.fill( jobstatsMsg( { runs: 6, ts: 115 } ) ); // restart: 6 new runs / 15s
		expect( v.snapshot().evtemplate.series.at( -1 ).runsRate ).toBeCloseTo(
			6 / 15
		);
	} );

	it( 'shows a nonzero rate at the reset point so a recycled run is not eaten', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 3, ts: 200 } ) ); // gen A ends at 3
		v.fill( jobstatsMsg( { runs: 1, ts: 210 } ) ); // gen B first record (reset)
		expect( v.snapshot().evtemplate.series.at( -1 ).runsRate ).toBeCloseTo(
			1 / 10
		);
	} );

	it( 'the first sample for a handler has rate 0 (no prior to delta against)', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 5000, ts: 100 } ) );
		expect( v.snapshot().evtemplate.series.at( -1 ).runsRate ).toBe( 0 );
	} );

	it( 'sums windowed run totals across worker generations (reset = new runs)', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 3, ts: 200 } ) ); // gen A ends at 3
		v.fill( jobstatsMsg( { runs: 1, ts: 210 } ) ); // gen B restart → 1
		expect( v.snapshot().evtemplate.windowed.runs ).toBe( 4 );
	} );

	it( 'sums windowed error totals across generations, counting the reset value', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { errors: 7, ts: 200 } ) ); // gen A
		v.fill( jobstatsMsg( { errors: 2, ts: 210 } ) ); // restart → 2
		expect( v.snapshot().evtemplate.windowed.errors ).toBe( 9 );
	} );

	it( 'sums windowed item totals (ok + err) across generations', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { itemsOk: 12, itemsErr: 4, ts: 200 } ) );
		v.fill( jobstatsMsg( { itemsOk: 3, itemsErr: 1, ts: 210 } ) ); // restart
		const { windowed } = v.snapshot().evtemplate;
		expect( windowed.itemsOk ).toBe( 15 );
		expect( windowed.itemsErr ).toBe( 5 );
	} );

	it( 'reports a delta-weighted average duration (Σ Δduration / Σ Δruns)', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 4, durationMs: 800, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 1, durationMs: 150, ts: 210 } ) ); // restart
		// Σduration = 950, Σruns = 5, avg = 190ms.
		expect( v.snapshot().evtemplate.windowed.avgDurationMs ).toBe( 190 );
	} );

	it( 'reports a delta-weighted average queue latency across generations', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 4, queueMs: 600, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 1, queueMs: 150, ts: 210 } ) ); // restart
		// Σqueue = 750, Σruns = 5, avg = 150ms.
		expect( v.snapshot().evtemplate.windowed.avgQueueMs ).toBe( 150 );
	} );

	it( 'guards divide-by-zero in windowed avg duration when no runs recorded', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 0, durationMs: 0, ts: 200 } ) );
		expect( v.snapshot().evtemplate.windowed.avgDurationMs ).toBe( 0 );
	} );

	it( 'shrinks windowed totals as old samples age out of the retention window', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 5, ts: 100 } ) ); // sample A: Δ5
		v.fill( jobstatsMsg( { runs: 8, ts: 200 } ) ); // sample B: Δ3
		expect( v.snapshot().evtemplate.windowed.runs ).toBe( 8 );
		// Advance wall-clock so sample A (ts = TS_BASE + 100) ages out.
		v._pruneExpired( ( TS_BASE + 150 + RETENTION_S ) * 1000 );
		expect( v.snapshot().evtemplate.windowed.runs ).toBe( 3 );
		// Age sample B out too → the identity vanishes from the model.
		v._pruneExpired( ( TS_BASE + 300 + RETENTION_S ) * 1000 );
		expect( v.snapshot().evtemplate ).toBeUndefined();
	} );

	it( 'exposes the latest cumulative + last-run detail for the table', () => {
		const v = new JobstatsViewNode();
		v.fill(
			jobstatsMsg( {
				runs: 4,
				errors: 1,
				durationMs: 800, // avg = 200ms
				queueMs: 400, // avg = 100ms
				itemsOk: 20,
				itemsErr: 3,
				lastTs: 1_700_000_123,
				lastDurationMs: 250,
				lastStatus: 'error',
				lastMessage: 'Job failed: 3 error(s), no items processed',
				ts: 100,
			} )
		);
		const { latest } = v.snapshot().evtemplate;
		expect( latest.runs ).toBe( 4 );
		expect( latest.errors ).toBe( 1 );
		expect( latest.itemsOk ).toBe( 20 );
		expect( latest.itemsErr ).toBe( 3 );
		expect( latest.lastTs ).toBe( 1_700_000_123 );
		expect( latest.lastDurationMs ).toBe( 250 );
		expect( latest.lastStatus ).toBe( 'error' );
		expect( latest.lastMessage ).toBe(
			'Job failed: 3 error(s), no items processed'
		);
	} );

	it( 'ignores a record older than the 24h retention window', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 5, ts: -80000 } ) ); // before the window
		expect( v.snapshot() ).toEqual( {} );
	} );

	it( 'yields rate 0 when consecutive records share a timestamp (no Δts)', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 2, ts: 100 } ) );
		v.fill( jobstatsMsg( { runs: 9, ts: 100 } ) ); // same ts → dt 0
		const snap = v.snapshot().evtemplate;
		expect( snap.series.at( -1 ).runsRate ).toBe( 0 );
		// The run still counts toward the windowed total (Δ7 + the first Δ2).
		expect( snap.windowed.runs ).toBe( 9 );
	} );

	it( 'ignores a non-jobstats message (VALUE not a positional array)', () => {
		const v = new JobstatsViewNode();
		const m = newMessage();
		m[ TYPE ] = TM_STRUCT;
		m[ VALUE ] = { hello: 'world' };
		expect( () => v.fill( m ) ).not.toThrow();
		expect( v.snapshot() ).toEqual( {} );
	} );

	it( "publishes the view model under a 'handlers' key via setState('view')", () => {
		const v = new JobstatsViewNode();
		const published = [];
		v.setState = ( key, value ) => published.push( [ key, value ] );
		v.fill( jobstatsMsg( { ts: 100 } ) );
		expect( published.length ).toBeGreaterThanOrEqual( 1 );
		expect( published[ 0 ][ 0 ] ).toBe( 'view' );
		expect( published[ 0 ][ 1 ].handlers.evtemplate ).toBeTruthy();
	} );

	it( 'snapshot() returns a FRESH series array each call (never the live reference)', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { ts: 100 } ) );
		const a = v.snapshot().evtemplate.series;
		const b = v.snapshot().evtemplate.series;
		expect( a ).not.toBe( b );
		expect( a ).toEqual( b );
	} );
} );
