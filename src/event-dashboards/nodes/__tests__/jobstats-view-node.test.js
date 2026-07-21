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

	it( 'treats a RUNS drop (worker restart) as rate 0, never negative', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 9000, ts: 100 } ) );
		v.fill( jobstatsMsg( { runs: 5, ts: 115 } ) ); // counter reset
		expect( v.snapshot().evtemplate.series.at( -1 ).runsRate ).toBe( 0 );
	} );

	it( 'the first sample for a handler has rate 0 (no prior to delta against)', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 5000, ts: 100 } ) );
		expect( v.snapshot().evtemplate.series.at( -1 ).runsRate ).toBe( 0 );
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
		expect( latest.avgDurationMs ).toBe( 200 );
		expect( latest.avgQueueMs ).toBe( 100 );
		expect( latest.itemsOk ).toBe( 20 );
		expect( latest.itemsErr ).toBe( 3 );
		expect( latest.lastTs ).toBe( 1_700_000_123 );
		expect( latest.lastDurationMs ).toBe( 250 );
		expect( latest.lastStatus ).toBe( 'error' );
		expect( latest.lastMessage ).toBe(
			'Job failed: 3 error(s), no items processed'
		);
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
