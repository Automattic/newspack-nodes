import { ProbeStreamViewNode } from '../probe-stream-view-node';
import { JobstatsViewNode } from '../jobstats-view-node';
import { TopicProbeViewNode } from '../topic-probe-view-node';
import {
	newMessage,
	TYPE,
	TIMESTAMP,
	VALUE,
	TM_STRUCT,
} from '../../../runtime/message';
// Namespaced: the two record layouts both export ELAPSED_MS.
import * as Job from '../../../runtime/jobstats-record';
import * as Probe from '../../../runtime/probe-record';

// A layout sharing no slot with either real record, so nothing can pass by luck.
const WIDGET_ID = 2;
const WIDGET_LABEL = 3;
const WIDGET_WEIGHT = 4;

/** Minimal concrete view: the layout mapping and nothing else. */
class WidgetProbeView extends ProbeStreamViewNode {
	identitySlot = WIDGET_ID;
	modelKey = 'widgets';
	static description = 'Widget probe stream sink (the base-contract double).';

	_fold( entry, value, ts ) {
		entry.label = String( value[ WIDGET_LABEL ] ?? entry.label ?? '' );
		return { ts, weight: this._delta( value[ WIDGET_WEIGHT ] ) };
	}

	_entryView( entry ) {
		return { label: entry.label, series: entry.series.slice() };
	}
}

// Offset from a recent epoch base so records land inside the 24h window.
const TS_BASE = Math.floor( Date.now() / 1000 ) - 10000;

function widgetMsg( {
	ts = 500,
	absTs = null,
	id = 'zeta-7',
	label = 'zeta',
	weight = 0,
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = null !== absTs ? absTs : TS_BASE + ts;
	const v = [];
	v[ WIDGET_ID ] = id;
	v[ WIDGET_LABEL ] = label;
	v[ WIDGET_WEIGHT ] = weight;
	m[ VALUE ] = v;
	return m;
}

describe( 'ProbeStreamViewNode (the entry-lifecycle contract)', () => {
	it( 'keys an entry by identitySlot and pushes what _fold returns', () => {
		const v = new WidgetProbeView();
		v.fill( widgetMsg( { id: 'zeta-7', label: 'zeta', weight: 19 } ) );
		const snap = v.snapshot();
		expect( Object.keys( snap ) ).toEqual( [ 'zeta-7' ] );
		expect( snap[ 'zeta-7' ].label ).toBe( 'zeta' );
		expect( snap[ 'zeta-7' ].series ).toEqual( [
			{ ts: TS_BASE + 500, weight: 19 },
		] );
	} );

	it( 'reuses one entry across records, so _fold can carry fields forward', () => {
		const v = new WidgetProbeView();
		v.fill( widgetMsg( { label: 'zeta', ts: 500 } ) );
		v.fill( widgetMsg( { label: undefined, ts: 501 } ) );
		const entry = v.snapshot()[ 'zeta-7' ];
		expect( entry.label ).toBe( 'zeta' );
		expect( entry.series.length ).toBe( 2 );
	} );

	it( 'caps the series at the constructor ring cap', () => {
		const v = new WidgetProbeView( 2 );
		for ( let i = 0; i < 5; i++ ) {
			v.fill( widgetMsg( { ts: 600 + i, weight: i } ) );
		}
		const series = v.snapshot()[ 'zeta-7' ].series;
		expect( series.length ).toBe( 2 );
		expect( series.at( -1 ).ts ).toBe( TS_BASE + 604 );
	} );

	it( 'never folds a record older than the 24h window', () => {
		const v = new WidgetProbeView();
		v.fill(
			widgetMsg( { absTs: Math.floor( Date.now() / 1000 ) - 90000 } )
		);
		expect( v.snapshot() ).toEqual( {} );
	} );

	it( 'ignores a record whose identity slot is not a non-empty string', () => {
		const v = new WidgetProbeView();
		v.fill( widgetMsg( { id: '' } ) );
		v.fill( widgetMsg( { id: 41 } ) );
		expect( v.snapshot() ).toEqual( {} );
	} );

	it( "publishes the model under the subclass's modelKey", () => {
		const v = new WidgetProbeView();
		const published = [];
		v.setState = ( key, value ) => published.push( [ key, value ] );
		v.fill( widgetMsg( { weight: 19 } ) );
		expect( published[ 0 ][ 0 ] ).toBe( 'view' );
		expect( published[ 0 ][ 1 ].widgets[ 'zeta-7' ].label ).toBe( 'zeta' );
	} );

	it( "publishes one hidden, terminal schema carrying the subclass's description", () => {
		expect( WidgetProbeView.nodeSchema() ).toEqual( {
			category: 'Hidden',
			description: 'Widget probe stream sink (the base-contract double).',
			has_target: false,
			arguments: [],
			commands: [],
		} );
	} );
} );

// The node's live window is a fixed 24h; samples older than this are pruned.
const RETENTION_S = 86400;

// Build a probe TM_STRUCT: positional VALUE, instant in TIMESTAMP.
function probeMsg( {
	ts = 1000,
	absTs = null,
	reader = 'firehose.p0',
	source = 'firehose.p0',
	distance = 0,
	msgs = 0,
	bytes = 0,
	cacheSize = 0,
	elapsedMs = 15000,
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = null !== absTs ? absTs : TS_BASE + ts;
	const v = [];
	v[ Probe.SOURCE ] = source;
	v[ Probe.READER ] = reader;
	v[ Probe.DISTANCE ] = distance;
	v[ Probe.MSGS_DELTA ] = msgs;
	v[ Probe.BYTES_READ_DELTA ] = bytes;
	v[ Probe.CACHE_SIZE ] = cacheSize;
	v[ Probe.ELAPSED_MS ] = elapsedMs;
	m[ VALUE ] = v;
	return m;
}

describe( 'TopicProbeViewNode', () => {
	it( 'indexes samples by reader, carrying the source', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { reader: 'firehose.p0', source: 'firehose.p0' } ) );
		v.fill( probeMsg( { reader: 'jobs.p0', source: 'jobs.p0' } ) );
		const snap = v.snapshot();
		expect( Object.keys( snap ).sort() ).toEqual( [
			'firehose.p0',
			'jobs.p0',
		] );
		expect( snap[ 'firehose.p0' ].source ).toBe( 'firehose.p0' );
	} );

	it( 'divides ONE record: msgRate is its MSGS_DELTA over its own ELAPSED_MS', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: 3000, elapsedMs: 3000, ts: 103 } ) );
		expect( v.snapshot()[ 'firehose.p0' ].latest.msgRate ).toBe( 1000 );
	} );

	it( 'divides ONE record: byteRate is its BYTES_READ_DELTA over its own ELAPSED_MS', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { bytes: 3000, elapsedMs: 3000, ts: 103 } ) );
		expect( v.snapshot()[ 'firehose.p0' ].latest.byteRate ).toBe( 1000 );
	} );

	it( 'keeps a non-zero rate across a worker restart (the counter reset that used to plot a literal 0)', () => {
		// A worker recycles every ~595s. The pre-restart record reports a big
		// window of work; the recycled generation's FIRST record reports its own
		// small window. Both are real rates — neither is 0.
		const v = new TopicProbeViewNode();
		v.fill(
			probeMsg( { msgs: 4230, bytes: 84600, elapsedMs: 15000, ts: 100 } )
		);
		v.fill(
			probeMsg( { msgs: 37, bytes: 740, elapsedMs: 15000, ts: 115 } )
		);
		const series = v.snapshot()[ 'firehose.p0' ].series;
		expect( series[ 0 ].msgRate ).toBeCloseTo( 282, 5 );
		expect( series[ 1 ].msgRate ).toBeCloseTo( 37 / 15, 5 );
		expect( series[ 1 ].byteRate ).toBeCloseTo( 740 / 15, 5 );
	} );

	it( 'a zero-elapsed record reads as rate 0 rather than dividing by zero', () => {
		// Two sweeps inside one clock second (the shutdown sweep right after a
		// tick) carry ELAPSED_MS 0. The delta still rides for the totals.
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: 91, bytes: 1820, elapsedMs: 0, ts: 100 } ) );
		const latest = v.snapshot()[ 'firehose.p0' ].latest;
		expect( latest.msgRate ).toBe( 0 );
		expect( latest.byteRate ).toBe( 0 );
		expect( latest.msgs ).toBe( 91 );
	} );

	it( 'carries the record delta and elapsed onto the sample, so buckets can re-divide', () => {
		const v = new TopicProbeViewNode();
		v.fill(
			probeMsg( { msgs: 91, bytes: 1820, elapsedMs: 15000, ts: 100 } )
		);
		const latest = v.snapshot()[ 'firehose.p0' ].latest;
		expect( latest.msgs ).toBe( 91 );
		expect( latest.bytes ).toBe( 1820 );
		expect( latest.elapsed ).toBe( 15 );
	} );

	it( 'reports the latest offsetlog cache size', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { cacheSize: 4096, ts: 100 } ) );
		v.fill( probeMsg( { cacheSize: 8192, ts: 115 } ) );
		expect( v.snapshot()[ 'firehose.p0' ].latest.cacheSize ).toBe( 8192 );
	} );

	it( 'reports the latest distance as the backlog', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { distance: 500, ts: 100 } ) );
		v.fill( probeMsg( { distance: 7800, ts: 115 } ) );
		expect( v.snapshot()[ 'firehose.p0' ].latest.backlog ).toBe( 7800 );
	} );

	it( 'a negative delta (a corrupt record) reads as 0, never negative', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: -200, bytes: -9, ts: 115 } ) );
		const latest = v.snapshot()[ 'firehose.p0' ].latest;
		expect( latest.msgRate ).toBe( 0 );
		expect( latest.byteRate ).toBe( 0 );
	} );

	it( 'the FIRST record for a consumer already carries a rate (it is self-contained)', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: 5000, elapsedMs: 5000, ts: 100 } ) );
		expect( v.snapshot()[ 'firehose.p0' ].latest.msgRate ).toBe( 1000 );
	} );

	it( 'keeps a bounded rate+backlog series per consumer (ring-capped)', () => {
		const v = new TopicProbeViewNode( 3 ); // cap = 3 samples
		for ( let i = 0; i < 6; i++ ) {
			v.fill( probeMsg( { msgs: i * 1000, ts: 100 + i } ) );
		}
		const c = v.snapshot()[ 'firehose.p0' ];
		expect( c.series.length ).toBe( 3 );
		expect( c.series[ c.series.length - 1 ].ts ).toBe( TS_BASE + 105 );
	} );

	it( 'drops an incoming probe record older than the 24h window (stale replay tail)', () => {
		const staleTs = Math.floor( Date.now() / 1000 ) - 25 * 3600; // 25h ago
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { absTs: staleTs } ) );
		// Never accumulated: a record past the window can't widen the axis.
		expect( v.snapshot()[ 'firehose.p0' ] ).toBeUndefined();
	} );

	it( "prunes an IDLE consumer's aged samples when ANOTHER consumer drives the publish (time-based, across all consumers)", () => {
		jest.useFakeTimers();
		try {
			const v = new TopicProbeViewNode();
			const oldTs = Math.floor( Date.now() / 1000 ); // fresh on arrival
			v.fill(
				probeMsg( {
					reader: 'idle.p0',
					source: 'idle.p0',
					absTs: oldTs,
				} )
			);
			// 25h passes; the prune must sweep ALL consumers, not just idle.p0.
			jest.advanceTimersByTime( 25 * 3600 * 1000 );
			const freshTs = Math.floor( Date.now() / 1000 );
			v.fill(
				probeMsg( {
					reader: 'live.p0',
					source: 'live.p0',
					absTs: freshTs,
				} )
			);
			const snap = v.snapshot();
			expect( snap[ 'idle.p0' ] ).toBeUndefined(); // aged out → skipped
			expect( snap[ 'live.p0' ].series.map( ( s ) => s.ts ) ).toEqual( [
				freshTs,
			] );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'ignores a non-probe message (VALUE not a positional array) without throwing', () => {
		const v = new TopicProbeViewNode();
		const m = newMessage();
		m[ TYPE ] = TM_STRUCT;
		m[ VALUE ] = { hello: 'world' };
		expect( () => v.fill( m ) ).not.toThrow();
		expect( v.snapshot() ).toEqual( {} );
	} );

	it( 'publishes a TRAILING update for a burst, so the newest sample is not swallowed by the leading-edge throttle', () => {
		jest.useFakeTimers();
		try {
			const v = new TopicProbeViewNode();
			const published = [];
			v.setState = ( key, value ) => published.push( value );
			v.fill( probeMsg( { distance: 100, ts: 100 } ) ); // publishes now
			expect( published.length ).toBe( 1 );
			v.fill( probeMsg( { distance: 999, ts: 101 } ) ); // deferred
			expect( published.length ).toBe( 1 );
			jest.advanceTimersByTime( 500 );
			expect( published.length ).toBe( 2 ); // trailing flush fired
			expect(
				published[ 1 ].consumers[ 'firehose.p0' ].latest.backlog
			).toBe( 999 );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'snapshot() returns a FRESH series array each call (never the live mutating reference)', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { ts: 100 } ) );
		const a = v.snapshot()[ 'firehose.p0' ].series;
		const b = v.snapshot()[ 'firehose.p0' ].series;
		expect( a ).not.toBe( b ); // distinct identities → memo sees a change
		expect( a ).toEqual( b ); // same contents
	} );

	it( 'evicts a consumer not seen within the liveness TTL (no unbounded growth)', () => {
		jest.useFakeTimers();
		try {
			const v = new TopicProbeViewNode( undefined, 1000 ); // ttlMs = 1s
			v.fill( probeMsg( { reader: 'gone.p0', ts: 100 } ) );
			expect( v.snapshot()[ 'gone.p0' ] ).toBeTruthy();
			// LIVE stream: no outage re-baseline; gone.p0 evicts on own TTL.
			for ( let t = 200; t <= 2000; t += 500 ) {
				jest.advanceTimersByTime( 500 );
				v.fill( probeMsg( { reader: 'alive.p0', ts: t } ) );
			}
			expect( v.snapshot()[ 'gone.p0' ] ).toBeUndefined();
			expect( v.snapshot()[ 'alive.p0' ] ).toBeTruthy();
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'does NOT evict pre-existing consumers when the first frame arrives after a gap larger than the TTL (stream was hidden/closed, not consumers dying)', () => {
		jest.useFakeTimers();
		try {
			const v = new TopicProbeViewNode( undefined, 1000 ); // ttlMs = 1s
			v.fill( probeMsg( { reader: 'a.p0', ts: 100 } ) );
			v.fill( probeMsg( { reader: 'b.p0', ts: 100 } ) );
			// Tab hidden > TTL: first reconnect frame must NOT wipe consumers.
			jest.advanceTimersByTime( 5000 ); // gap >> ttlMs
			v.fill( probeMsg( { reader: 'a.p0', ts: 200 } ) );
			expect( v.snapshot()[ 'a.p0' ] ).toBeTruthy();
			expect( v.snapshot()[ 'b.p0' ] ).toBeTruthy();
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'after a gap, does NOT grant a fresh full TTL to a consumer that was already silent before the outage — it evicts on its real schedule', () => {
		jest.useFakeTimers();
		try {
			const v = new TopicProbeViewNode( undefined, 1000 ); // ttlMs = 1s
			// dead.p0 produces once, then goes silent for good.
			v.fill( probeMsg( { reader: 'dead.p0', ts: 100 } ) ); // real-time 0
			// keepalive.p0 advances _lastFill so dead.p0 predates the outage.
			jest.advanceTimersByTime( 500 );
			v.fill( probeMsg( { reader: 'keepalive.p0', ts: 105 } ) ); // rt=500
			// Outage (gap>ttl): shift the lease by the outage, don't reset it.
			jest.advanceTimersByTime( 1500 );
			v.fill( probeMsg( { reader: 'live.p0', ts: 110 } ) ); // rt=2000
			// Another outage-free fill: dead.p0 (past ttl) is now gone.
			jest.advanceTimersByTime( 600 );
			v.fill( probeMsg( { reader: 'live.p0', ts: 111 } ) ); // rt=2600
			const snap = v.snapshot();
			expect( snap[ 'dead.p0' ] ).toBeUndefined();
			expect( snap[ 'keepalive.p0' ] ).toBeTruthy();
			expect( snap[ 'live.p0' ] ).toBeTruthy();
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'removeNode clears any pending trailing-publish timer (no setState after teardown)', () => {
		jest.useFakeTimers();
		try {
			const v = new TopicProbeViewNode();
			const published = [];
			v.setState = ( key, value ) => published.push( value );
			v.fill( probeMsg( { ts: 100 } ) ); // leading publish
			v.fill( probeMsg( { ts: 101 } ) ); // schedules a trailing flush
			v.removeNode();
			jest.advanceTimersByTime( 1000 );
			expect( published.length ).toBe( 1 ); // trailing flush cancelled
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'publishes a throttled view model via setState("view")', () => {
		const v = new TopicProbeViewNode();
		const published = [];
		v.setState = ( key, value ) => published.push( [ key, value ] );
		v.fill( probeMsg( { ts: 100 } ) );
		expect( published.length ).toBeGreaterThanOrEqual( 1 );
		expect( published[ 0 ][ 0 ] ).toBe( 'view' );
		expect( published[ 0 ][ 1 ].consumers[ 'firehose.p0' ] ).toBeTruthy();
	} );
} );

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
	v[ Job.IDENTITY ] = key;
	v[ Job.HANDLER ] = handler;
	v[ Job.RUNS_DELTA ] = runs;
	v[ Job.ERRORS_DELTA ] = errors;
	v[ Job.DURATION_MS_DELTA ] = durationMs;
	v[ Job.QUEUE_MS_DELTA ] = queueMs;
	v[ Job.ITEMS_OK_DELTA ] = itemsOk;
	v[ Job.ITEMS_ERR_DELTA ] = itemsErr;
	v[ Job.LAST_TS ] = lastTs;
	v[ Job.LAST_DURATION_MS ] = lastDurationMs;
	v[ Job.LAST_STATUS ] = lastStatus;
	v[ Job.LAST_MESSAGE ] = lastMessage;
	v[ Job.ELAPSED_MS ] = elapsedMs;
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
