import { JobstatsViewNode } from '../jobstats-view-node';
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
	RUNS_DELTA,
	ERRORS_DELTA,
	DURATION_MS_DELTA,
	QUEUE_MS_DELTA,
	ITEMS_OK_DELTA,
	ITEMS_ERR_DELTA,
	LAST_TS,
	LAST_DURATION_MS,
	LAST_STATUS,
	LAST_MESSAGE,
	ELAPSED_MS,
} from '../../../runtime/jobstats-record';

// Probe ts is an OFFSET from a recent epoch base so records stay in the 24h window.
const TS_BASE = Math.floor( Date.now() / 1000 ) - 10000;

// The node's live window is a fixed 24h; samples older than this are pruned.
const RETENTION_S = 86400;

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
	elapsedMs = 15000,
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = TS_BASE + ts;
	const v = [];
	v[ KEY ] = key;
	v[ HANDLER ] = handler;
	v[ RUNS_DELTA ] = runs;
	v[ ERRORS_DELTA ] = errors;
	v[ DURATION_MS_DELTA ] = durationMs;
	v[ QUEUE_MS_DELTA ] = queueMs;
	v[ ITEMS_OK_DELTA ] = itemsOk;
	v[ ITEMS_ERR_DELTA ] = itemsErr;
	v[ LAST_TS ] = lastTs;
	v[ LAST_DURATION_MS ] = lastDurationMs;
	v[ LAST_STATUS ] = lastStatus;
	v[ LAST_MESSAGE ] = lastMessage;
	v[ ELAPSED_MS ] = elapsedMs;
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
		// The identity rides the entry so per-identity charts can key on it.
		expect( snap[ 'cron:films' ].key ).toBe( 'cron:films' );
	} );

	it( 'derives per-sample queue latency (queue delta / runs delta) from ONE record', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 4, queueMs: 3200, ts: 115 } ) );
		expect( v.snapshot().evtemplate.series.at( -1 ).queueLatencyMs ).toBe(
			800
		);
	} );

	it( 'queue latency is 0 for a sample window with no runs', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 0, queueMs: 1000, ts: 115 } ) );
		expect( v.snapshot().evtemplate.series.at( -1 ).queueLatencyMs ).toBe(
			0
		);
	} );

	it( 'divides ONE record: runsRate is its RUNS_DELTA over its own ELAPSED_MS', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 30, elapsedMs: 3000, ts: 103 } ) );
		expect( v.snapshot().evtemplate.series.at( -1 ).runsRate ).toBe( 10 );
	} );

	it( 'divides ONE record: errorsRate is its ERRORS_DELTA over its own ELAPSED_MS', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { errors: 6, elapsedMs: 3000, ts: 103 } ) );
		expect( v.snapshot().evtemplate.series.at( -1 ).errorsRate ).toBe( 2 );
	} );

	it( 'keeps a non-zero rate across a worker restart (no reset detection left)', () => {
		// A recycled generation's first record carries its OWN window's work, so
		// there is no cumulative to compare and nothing to mis-read as a reset.
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 42, elapsedMs: 15000, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 6, elapsedMs: 10000, ts: 210 } ) );
		const series = v.snapshot().evtemplate.series;
		expect( series[ 0 ].runsRate ).toBeCloseTo( 42 / 15, 5 );
		expect( series[ 1 ].runsRate ).toBeCloseTo( 6 / 10, 5 );
	} );

	it( 'a zero-elapsed record reads as rate 0 rather than dividing by zero', () => {
		// Two sweeps inside one clock second (the shutdown sweep right after a
		// tick) carry ELAPSED_MS 0. The work still counts toward the totals.
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 9, elapsedMs: 0, ts: 100 } ) );
		const snap = v.snapshot().evtemplate;
		expect( snap.series.at( -1 ).runsRate ).toBe( 0 );
		expect( snap.windowed.runs ).toBe( 9 );
	} );

	it( 'a negative delta (a corrupt record) contributes nothing', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: -5, errors: -2, ts: 100 } ) );
		const snap = v.snapshot().evtemplate;
		expect( snap.series.at( -1 ).runsRate ).toBe( 0 );
		expect( snap.windowed.runs ).toBe( 0 );
	} );

	it( 'sums windowed run totals across worker generations', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 3, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 1, ts: 210 } ) ); // recycled generation
		expect( v.snapshot().evtemplate.windowed.runs ).toBe( 4 );
	} );

	it( 'sums windowed error totals across generations', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { errors: 7, ts: 200 } ) );
		v.fill( jobstatsMsg( { errors: 2, ts: 210 } ) );
		expect( v.snapshot().evtemplate.windowed.errors ).toBe( 9 );
	} );

	it( 'sums windowed item totals (ok + err) across generations', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { itemsOk: 12, itemsErr: 4, ts: 200 } ) );
		v.fill( jobstatsMsg( { itemsOk: 3, itemsErr: 1, ts: 210 } ) );
		const { windowed } = v.snapshot().evtemplate;
		expect( windowed.itemsOk ).toBe( 15 );
		expect( windowed.itemsErr ).toBe( 5 );
	} );

	it( 'reports a delta-weighted average duration (Σ duration / Σ runs)', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 4, durationMs: 800, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 1, durationMs: 150, ts: 210 } ) );
		// Σduration = 950, Σruns = 5, avg = 190ms.
		expect( v.snapshot().evtemplate.windowed.avgDurationMs ).toBe( 190 );
	} );

	it( 'reports a delta-weighted average queue latency across generations', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 4, queueMs: 600, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 1, queueMs: 150, ts: 210 } ) );
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
		v.fill( jobstatsMsg( { runs: 5, ts: 100 } ) );
		v.fill( jobstatsMsg( { runs: 3, ts: 200 } ) );
		expect( v.snapshot().evtemplate.windowed.runs ).toBe( 8 );
		// Advance wall-clock so sample A (ts = TS_BASE + 100) ages out.
		v._pruneExpired( ( TS_BASE + 150 + RETENTION_S ) * 1000 );
		expect( v.snapshot().evtemplate.windowed.runs ).toBe( 3 );
		// Age sample B out too → the identity vanishes from the model.
		v._pruneExpired( ( TS_BASE + 300 + RETENTION_S ) * 1000 );
		expect( v.snapshot().evtemplate ).toBeUndefined();
	} );

	it( 'exposes the last-run detail for the table', () => {
		const v = new JobstatsViewNode();
		v.fill(
			jobstatsMsg( {
				lastTs: 1_700_000_123,
				lastDurationMs: 250,
				lastStatus: 'error',
				lastMessage: 'Job failed: 3 error(s), no items processed',
				ts: 100,
			} )
		);
		const { latest } = v.snapshot().evtemplate;
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

	it( 'counts both records when consecutive sweeps share a timestamp', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 2, ts: 100 } ) );
		v.fill( jobstatsMsg( { runs: 7, ts: 100 } ) );
		expect( v.snapshot().evtemplate.windowed.runs ).toBe( 9 );
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
