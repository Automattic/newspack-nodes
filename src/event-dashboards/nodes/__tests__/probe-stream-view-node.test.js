import { ProbeStreamViewNode } from '../probe-stream-view-node';
import { JobstatsViewNode } from '../jobstats-view-node';
import { TopicProbeViewNode } from '../topic-probe-view-node';
import { TablestatsViewNode } from '../tablestats-view-node';
import {
	newMessage,
	TYPE,
	TIMESTAMP,
	FROM,
	VALUE,
	TM_STRUCT,
} from '../../../runtime/message';
// Namespaced: the two record layouts both export ELAPSED_MS.
import * as Job from '../../../runtime/jobstats-record';
import * as Probe from '../../../runtime/probe-record';
import * as Tbl from '../../../runtime/tablestats-record';

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
		const snap = v.snapshot( v.modelKey );
		expect( Object.keys( snap ) ).toEqual( [ 'zeta-7' ] );
		expect( snap[ 'zeta-7' ].label ).toBe( 'zeta' );
		expect( snap[ 'zeta-7' ].series ).toEqual( [
			{ ts: TS_BASE + 500, weight: 19 },
		] );
	} );

	it( 'hands _fold the worker workerOfFrom() reads, or none', () => {
		const workers = [];
		class WorkerSpyView extends WidgetProbeView {
			_fold( entry, value, ts, worker ) {
				workers.push( worker );
				return super._fold( entry, value, ts );
			}
		}
		const v = new WorkerSpyView();
		const froms = [
			'widgets.p4/lab-9.p7/widgets',
			'offsets/x.p0/job-worker.p2/jobstats',
			'widgets.p4/widgets',
			'x.p01',
			'widgets.p4/x.p01/widgets',
			'jobstats.p0/foo.p1',
			'widgets.p4/lab-9.p7/x.p5/widgets',
			'offsets/x.p0/widgets',
		];
		for ( const from of froms ) {
			const m = widgetMsg();
			m[ FROM ] = from;
			v.fill( m );
		}
		expect( workers ).toEqual( [
			'lab-9.p7',
			'job-worker.p2',
			'',
			'',
			'',
			'',
			'',
			'',
		] );
	} );

	it( 'reuses one entry across records, so _fold can carry fields forward', () => {
		const v = new WidgetProbeView();
		v.fill( widgetMsg( { label: 'zeta', ts: 500 } ) );
		v.fill( widgetMsg( { label: undefined, ts: 501 } ) );
		const entry = v.snapshot( v.modelKey )[ 'zeta-7' ];
		expect( entry.label ).toBe( 'zeta' );
		expect( entry.series.length ).toBe( 2 );
	} );

	it( 'caps the series at the constructor ring cap', () => {
		const v = new WidgetProbeView( 2 );
		for ( let i = 0; i < 5; i++ ) {
			v.fill( widgetMsg( { ts: 600 + i, weight: i } ) );
		}
		const series = v.snapshot( v.modelKey )[ 'zeta-7' ].series;
		expect( series.length ).toBe( 2 );
		expect( series.at( -1 ).ts ).toBe( TS_BASE + 604 );
	} );

	it( 'never folds a record older than the 24h window', () => {
		const v = new WidgetProbeView();
		v.fill(
			widgetMsg( { absTs: Math.floor( Date.now() / 1000 ) - 90000 } )
		);
		expect( v.snapshot( v.modelKey ) ).toEqual( {} );
	} );

	it( 'ignores a record whose identity slot is not a non-empty string', () => {
		const v = new WidgetProbeView();
		v.fill( widgetMsg( { id: '' } ) );
		v.fill( widgetMsg( { id: 41 } ) );
		expect( v.snapshot( v.modelKey ) ).toEqual( {} );
	} );

	it( "publishes the model under the subclass's modelKey", () => {
		const v = new WidgetProbeView();
		const published = [];
		v.notify = ( key ) => published.push( [ key, v.view ] );
		v.fill( widgetMsg( { weight: 19 } ) );
		expect( published[ 0 ][ 0 ] ).toBe( 'view' );
		expect( published[ 0 ][ 1 ].widgets[ 'zeta-7' ].label ).toBe( 'zeta' );
	} );

	it( "publishes one hidden, terminal schema carrying the subclass's description", () => {
		expect( WidgetProbeView.nodeSchema() ).toEqual( {
			category: 'Hidden',
			description: 'Widget probe stream sink (the base-contract double).',
			registrations: [ 'view' ],
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
	from = 'topicprobe.p0/topicprobe',
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = null !== absTs ? absTs : TS_BASE + ts;
	m[ FROM ] = from;
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

// A Partition record: READER blank, keyed by SOURCE.
function partitionMsg( {
	ts = 1000,
	source = 'ledger.p4',
	endBytes = 0,
	diskBytes = 0,
	from = 'topicprobe.p0/job-worker.p2/topicprobe',
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = TS_BASE + ts;
	m[ FROM ] = from;
	const v = [];
	v[ Probe.SOURCE ] = source;
	v[ Probe.READER ] = '';
	v[ Probe.END_BYTES ] = endBytes;
	v[ Probe.END_DISK_BYTES ] = diskBytes;
	m[ VALUE ] = v;
	return m;
}

describe( 'TopicProbeViewNode', () => {
	it( 'carries the worker FROM names on each sample', () => {
		const v = new TopicProbeViewNode();
		v.fill(
			probeMsg( {
				ts: 115,
				from: 'topicprobe.p0/request-builder-6612.p4/topicprobe',
			} )
		);
		v.fill( probeMsg( { ts: 130 } ) );
		expect(
			v
				.snapshot( v.modelKey )
				[ 'firehose.p0' ].series.map( ( s ) => s.worker )
		).toEqual( [ 'request-builder-6612.p4', '' ] );
	} );

	it( 'keys a Partition record by its SOURCE, apart from the consumers', () => {
		const v = new TopicProbeViewNode();
		v.fill(
			partitionMsg( { ts: 100, endBytes: 70913, diskBytes: 16384 } )
		);
		v.fill( probeMsg( { reader: 'jobs.ledger.p4', source: 'ledger.p4' } ) );
		const sample = {
			ts: TS_BASE + 100,
			worker: 'job-worker.p2',
			endBytes: 70913,
			diskBytes: 16384,
		};
		expect( Object.keys( v.snapshot( v.modelKey ) ) ).toEqual( [
			'jobs.ledger.p4',
		] );
		expect( v.snapshot( 'partitions' ) ).toEqual( {
			'ledger.p4': {
				source: 'ledger.p4',
				latest: sample,
				series: [ sample ],
			},
		} );
	} );

	it( "holds every worker's reading of one directory in its one series", () => {
		const v = new TopicProbeViewNode();
		v.fill( partitionMsg( { ts: 100, endBytes: 5003 } ) );
		v.fill(
			partitionMsg( {
				ts: 107,
				endBytes: 5780,
				from: 'topicprobe.p0/job-intake.p0/topicprobe',
			} )
		);
		const p = v.snapshot( 'partitions' )[ 'ledger.p4' ];
		expect( p.series.map( ( s ) => [ s.worker, s.endBytes ] ) ).toEqual( [
			[ 'job-worker.p2', 5003 ],
			[ 'job-intake.p0', 5780 ],
		] );
		expect( p.latest.endBytes ).toBe( 5780 );
	} );

	it( 'keeps two directories that share a basename apart', () => {
		const v = new TopicProbeViewNode();
		v.fill(
			partitionMsg( { source: 'offsets/ingest.p0', endBytes: 292 } )
		);
		v.fill(
			partitionMsg( { source: 'deadletter/ingest.p0', endBytes: 5113 } )
		);
		const p = v.snapshot( 'partitions' );
		expect( Object.keys( p ) ).toEqual( [
			'offsets/ingest.p0',
			'deadletter/ingest.p0',
		] );
		expect( p[ 'deadletter/ingest.p0' ].latest.endBytes ).toBe( 5113 );
	} );

	it( 'publishes the consumers and the partitions side by side', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { reader: 'jobs.ledger.p4' } ) );
		expect( Object.keys( v.view ) ).toEqual( [
			'consumers',
			'partitions',
		] );
		expect( v.view.partitions ).toEqual( {} );
	} );

	it( 'ignores a record with neither a reader nor a source', () => {
		const v = new TopicProbeViewNode();
		v.fill( partitionMsg( { source: '' } ) );
		expect( v.snapshot( v.modelKey ) ).toEqual( {} );
		expect( v.snapshot( 'partitions' ) ).toEqual( {} );
	} );

	it( 'indexes samples by reader, carrying the source', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { reader: 'firehose.p0', source: 'firehose.p0' } ) );
		v.fill( probeMsg( { reader: 'jobs.p0', source: 'jobs.p0' } ) );
		const snap = v.snapshot( v.modelKey );
		expect( Object.keys( snap ).sort() ).toEqual( [
			'firehose.p0',
			'jobs.p0',
		] );
		expect( snap[ 'firehose.p0' ].source ).toBe( 'firehose.p0' );
	} );

	it( 'divides ONE record: msgRate is its MSGS_DELTA over its own ELAPSED_MS', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: 3000, elapsedMs: 3000, ts: 103 } ) );
		expect( v.snapshot( v.modelKey )[ 'firehose.p0' ].latest.msgRate ).toBe(
			1000
		);
	} );

	it( 'divides ONE record: byteRate is its BYTES_READ_DELTA over its own ELAPSED_MS', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { bytes: 3000, elapsedMs: 3000, ts: 103 } ) );
		expect(
			v.snapshot( v.modelKey )[ 'firehose.p0' ].latest.byteRate
		).toBe( 1000 );
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
		const series = v.snapshot( v.modelKey )[ 'firehose.p0' ].series;
		expect( series[ 0 ].msgRate ).toBeCloseTo( 282, 5 );
		expect( series[ 1 ].msgRate ).toBeCloseTo( 37 / 15, 5 );
		expect( series[ 1 ].byteRate ).toBeCloseTo( 740 / 15, 5 );
	} );

	it( 'a zero-elapsed record reads as rate 0 rather than dividing by zero', () => {
		// Two sweeps inside one clock second (the shutdown sweep right after a
		// tick) carry ELAPSED_MS 0. The delta still rides for the totals.
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: 91, bytes: 1820, elapsedMs: 0, ts: 100 } ) );
		const latest = v.snapshot( v.modelKey )[ 'firehose.p0' ].latest;
		expect( latest.msgRate ).toBe( 0 );
		expect( latest.byteRate ).toBe( 0 );
		expect( latest.msgs ).toBe( 91 );
	} );

	it( 'carries the record delta and elapsed onto the sample, so buckets can re-divide', () => {
		const v = new TopicProbeViewNode();
		v.fill(
			probeMsg( { msgs: 91, bytes: 1820, elapsedMs: 15000, ts: 100 } )
		);
		const latest = v.snapshot( v.modelKey )[ 'firehose.p0' ].latest;
		expect( latest.msgs ).toBe( 91 );
		expect( latest.bytes ).toBe( 1820 );
		expect( latest.elapsed ).toBe( 15 );
	} );

	it( 'reports the latest offsetlog cache size', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { cacheSize: 4096, ts: 100 } ) );
		v.fill( probeMsg( { cacheSize: 8192, ts: 115 } ) );
		expect(
			v.snapshot( v.modelKey )[ 'firehose.p0' ].latest.cacheSize
		).toBe( 8192 );
	} );

	it( 'reports the latest distance as the backlog', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { distance: 500, ts: 100 } ) );
		v.fill( probeMsg( { distance: 7800, ts: 115 } ) );
		expect( v.snapshot( v.modelKey )[ 'firehose.p0' ].latest.backlog ).toBe(
			7800
		);
	} );

	it( 'a negative delta (a corrupt record) reads as 0, never negative', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: -200, bytes: -9, ts: 115 } ) );
		const latest = v.snapshot( v.modelKey )[ 'firehose.p0' ].latest;
		expect( latest.msgRate ).toBe( 0 );
		expect( latest.byteRate ).toBe( 0 );
	} );

	it( 'the FIRST record for a consumer already carries a rate (it is self-contained)', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: 5000, elapsedMs: 5000, ts: 100 } ) );
		expect( v.snapshot( v.modelKey )[ 'firehose.p0' ].latest.msgRate ).toBe(
			1000
		);
	} );

	it( 'keeps a bounded rate+backlog series per consumer (ring-capped)', () => {
		const v = new TopicProbeViewNode( 3 ); // cap = 3 samples
		for ( let i = 0; i < 6; i++ ) {
			v.fill( probeMsg( { msgs: i * 1000, ts: 100 + i } ) );
		}
		const c = v.snapshot( v.modelKey )[ 'firehose.p0' ];
		expect( c.series.length ).toBe( 3 );
		expect( c.series[ c.series.length - 1 ].ts ).toBe( TS_BASE + 105 );
	} );

	it( 'drops an incoming probe record older than the 24h window (stale replay tail)', () => {
		const staleTs = Math.floor( Date.now() / 1000 ) - 25 * 3600; // 25h ago
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { absTs: staleTs } ) );
		// Never accumulated: a record past the window can't widen the axis.
		expect( v.snapshot( v.modelKey )[ 'firehose.p0' ] ).toBeUndefined();
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
			const snap = v.snapshot( v.modelKey );
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
		expect( v.snapshot( v.modelKey ) ).toEqual( {} );
	} );

	it( 'publishes a TRAILING update for a burst, so the newest sample is not swallowed by the leading-edge throttle', () => {
		jest.useFakeTimers();
		try {
			const v = new TopicProbeViewNode();
			const published = [];
			v.notify = () => published.push( v.view );
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
		const a = v.snapshot( v.modelKey )[ 'firehose.p0' ].series;
		const b = v.snapshot( v.modelKey )[ 'firehose.p0' ].series;
		expect( a ).not.toBe( b ); // distinct identities → memo sees a change
		expect( a ).toEqual( b ); // same contents
	} );

	it( 'evicts a consumer not seen within the liveness TTL (no unbounded growth)', () => {
		jest.useFakeTimers();
		try {
			const v = new TopicProbeViewNode( undefined, 1000 ); // ttlMs = 1s
			v.fill( probeMsg( { reader: 'gone.p0', ts: 100 } ) );
			expect( v.snapshot( v.modelKey )[ 'gone.p0' ] ).toBeTruthy();
			// LIVE stream: no outage re-baseline; gone.p0 evicts on own TTL.
			for ( let t = 200; t <= 2000; t += 500 ) {
				jest.advanceTimersByTime( 500 );
				v.fill( probeMsg( { reader: 'alive.p0', ts: t } ) );
			}
			expect( v.snapshot( v.modelKey )[ 'gone.p0' ] ).toBeUndefined();
			expect( v.snapshot( v.modelKey )[ 'alive.p0' ] ).toBeTruthy();
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
			expect( v.snapshot( v.modelKey )[ 'a.p0' ] ).toBeTruthy();
			expect( v.snapshot( v.modelKey )[ 'b.p0' ] ).toBeTruthy();
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
			const snap = v.snapshot( v.modelKey );
			expect( snap[ 'dead.p0' ] ).toBeUndefined();
			expect( snap[ 'keepalive.p0' ] ).toBeTruthy();
			expect( snap[ 'live.p0' ] ).toBeTruthy();
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'removeNode clears any pending trailing-publish timer (no publish after teardown)', () => {
		jest.useFakeTimers();
		try {
			const v = new TopicProbeViewNode();
			const published = [];
			v.notify = () => published.push( v.view );
			v.fill( probeMsg( { ts: 100 } ) ); // leading publish
			v.fill( probeMsg( { ts: 101 } ) ); // schedules a trailing flush
			v.removeNode();
			jest.advanceTimersByTime( 1000 );
			expect( published.length ).toBe( 1 ); // trailing flush cancelled
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'publishes a throttled view model on the view field', () => {
		const v = new TopicProbeViewNode();
		const published = [];
		v.notify = ( key ) => published.push( [ key, v.view ] );
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
	maxDurationMs = 0,
	from = 'jobstats.p0/jobstats',
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = TS_BASE + ts;
	m[ FROM ] = from;
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
	v[ Job.MAX_DURATION_MS ] = maxDurationMs;
	m[ VALUE ] = v;
	return m;
}

describe( 'JobstatsViewNode', () => {
	it( 'carries each window’s longest run, and the window max across them', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 3, maxDurationMs: 211, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 2, maxDurationMs: 53, ts: 215 } ) );
		const snap = v.snapshot( v.modelKey ).evtemplate;
		expect( snap.series.map( ( s ) => s.maxDurationMs ) ).toEqual( [
			211, 53,
		] );
		expect( snap.windowed.maxDurationMs ).toBe( 211 );
	} );

	it( 'reads no window max when the window ran nothing', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 0, maxDurationMs: 0, ts: 200 } ) );
		expect(
			v.snapshot( v.modelKey ).evtemplate.windowed.maxDurationMs
		).toBeNull();
	} );

	it( 'carries the worker FROM names on each sample', () => {
		const v = new JobstatsViewNode();
		v.fill(
			jobstatsMsg( {
				ts: 115,
				from: 'jobstats.p0/job-worker.p2/jobstats',
			} )
		);
		v.fill( jobstatsMsg( { ts: 130, from: 'jobstats.p0/jobstats' } ) );
		expect(
			v.snapshot( v.modelKey ).evtemplate.series.map( ( s ) => s.worker )
		).toEqual( [ 'job-worker.p2', '' ] );
	} );

	it( 'caps an identity per worker, so four workers keep a whole day each', () => {
		// 1500 sweeps a worker passes 5761 / 4: one shared cap would trim it.
		const v = new JobstatsViewNode();
		const sweeps = 1500;
		for ( let i = 0; i < sweeps; i++ ) {
			for ( const p of [ 0, 1, 2, 3 ] ) {
				v.fill(
					jobstatsMsg( {
						key: 'cron:films',
						runs: 1,
						ts: -12500 + i * 15,
						from: `jobstats.p0/job-worker.p${ p }/jobstats`,
					} )
				);
			}
		}
		const series = v.snapshot( v.modelKey )[ 'cron:films' ].series;
		v.removeNode();
		expect( series.length ).toBe( 4 * sweeps );
		expect( series[ 0 ].ts ).toBe( TS_BASE - 12500 );
	} );

	it( 'keeps the newest last run when an older run arrives later', () => {
		const v = new JobstatsViewNode();
		v.fill(
			jobstatsMsg( {
				ts: 300,
				lastTs: 1_790_036_000,
				lastStatus: 'error',
				lastMessage: 'Job failed: 4 error(s)',
				lastDurationMs: 811,
				from: 'jobstats.p0/job-worker.p0/jobstats',
			} )
		);
		v.fill(
			jobstatsMsg( {
				ts: 301,
				lastTs: 1_790_032_400,
				lastStatus: 'success',
				lastMessage: 'Job completed successfully',
				lastDurationMs: 37,
				from: 'jobstats.p0/job-worker.p1/jobstats',
			} )
		);
		expect( v.snapshot( v.modelKey ).evtemplate.latest ).toEqual( {
			lastTs: 1_790_036_000,
			lastDurationMs: 811,
			lastStatus: 'error',
			lastMessage: 'Job failed: 4 error(s)',
		} );
	} );

	it( 'indexes handlers by identity key, carrying the handler name', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { key: 'cron:films', handler: 'cron' } ) );
		v.fill( jobstatsMsg( { key: 'evtemplate', handler: 'evtemplate' } ) );
		const snap = v.snapshot( v.modelKey );
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
		expect(
			v.snapshot( v.modelKey ).evtemplate.series.at( -1 ).queueLatencyMs
		).toBe( 800 );
	} );

	it( 'queue latency is 0 for a sample window with no runs', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 0, queueMs: 1000, ts: 115 } ) );
		expect(
			v.snapshot( v.modelKey ).evtemplate.series.at( -1 ).queueLatencyMs
		).toBe( 0 );
	} );

	it( 'divides ONE record: runsRate is its RUNS_DELTA over its own ELAPSED_MS', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 30, elapsedMs: 3000, ts: 103 } ) );
		expect(
			v.snapshot( v.modelKey ).evtemplate.series.at( -1 ).runsRate
		).toBe( 10 );
	} );

	it( 'divides ONE record: errorsRate is its ERRORS_DELTA over its own ELAPSED_MS', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { errors: 6, elapsedMs: 3000, ts: 103 } ) );
		expect(
			v.snapshot( v.modelKey ).evtemplate.series.at( -1 ).errorsRate
		).toBe( 2 );
	} );

	it( 'keeps a non-zero rate across a worker restart (no reset detection left)', () => {
		// A recycled generation's first record carries its OWN window's work, so
		// there is no cumulative to compare and nothing to mis-read as a reset.
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 42, elapsedMs: 15000, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 6, elapsedMs: 10000, ts: 210 } ) );
		const series = v.snapshot( v.modelKey ).evtemplate.series;
		expect( series[ 0 ].runsRate ).toBeCloseTo( 42 / 15, 5 );
		expect( series[ 1 ].runsRate ).toBeCloseTo( 6 / 10, 5 );
	} );

	it( 'a zero-elapsed record reads as rate 0 rather than dividing by zero', () => {
		// Two sweeps inside one clock second (the shutdown sweep right after a
		// tick) carry ELAPSED_MS 0. The work still counts toward the totals.
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 9, elapsedMs: 0, ts: 100 } ) );
		const snap = v.snapshot( v.modelKey ).evtemplate;
		expect( snap.series.at( -1 ).runsRate ).toBe( 0 );
		expect( snap.windowed.runs ).toBe( 9 );
	} );

	it( 'a negative delta (a corrupt record) contributes nothing', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: -5, errors: -2, ts: 100 } ) );
		const snap = v.snapshot( v.modelKey ).evtemplate;
		expect( snap.series.at( -1 ).runsRate ).toBe( 0 );
		expect( snap.windowed.runs ).toBe( 0 );
	} );

	it( 'sums windowed run totals across worker generations', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 3, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 1, ts: 210 } ) ); // recycled generation
		expect( v.snapshot( v.modelKey ).evtemplate.windowed.runs ).toBe( 4 );
	} );

	it( 'sums windowed error totals across generations', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { errors: 7, ts: 200 } ) );
		v.fill( jobstatsMsg( { errors: 2, ts: 210 } ) );
		expect( v.snapshot( v.modelKey ).evtemplate.windowed.errors ).toBe( 9 );
	} );

	it( 'sums windowed item totals (ok + err) across generations', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { itemsOk: 12, itemsErr: 4, ts: 200 } ) );
		v.fill( jobstatsMsg( { itemsOk: 3, itemsErr: 1, ts: 210 } ) );
		const { windowed } = v.snapshot( v.modelKey ).evtemplate;
		expect( windowed.itemsOk ).toBe( 15 );
		expect( windowed.itemsErr ).toBe( 5 );
	} );

	it( 'reports a delta-weighted average duration (Σ duration / Σ runs)', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 4, durationMs: 800, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 1, durationMs: 150, ts: 210 } ) );
		// Σduration = 950, Σruns = 5, avg = 190ms.
		expect(
			v.snapshot( v.modelKey ).evtemplate.windowed.avgDurationMs
		).toBe( 190 );
	} );

	it( 'reports a delta-weighted average queue latency across generations', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 4, queueMs: 600, ts: 200 } ) );
		v.fill( jobstatsMsg( { runs: 1, queueMs: 150, ts: 210 } ) );
		// Σqueue = 750, Σruns = 5, avg = 150ms.
		expect( v.snapshot( v.modelKey ).evtemplate.windowed.avgQueueMs ).toBe(
			150
		);
	} );

	it( 'reads no average for a window with no runs, rather than 0', () => {
		const v = new JobstatsViewNode();
		v.fill(
			jobstatsMsg( { runs: 0, durationMs: 0, queueMs: 0, ts: 200 } )
		);
		const { windowed } = v.snapshot( v.modelKey ).evtemplate;
		expect( windowed.avgDurationMs ).toBeNull();
		expect( windowed.avgQueueMs ).toBeNull();
	} );

	it( 'shrinks windowed totals as old samples age out of the retention window', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 5, ts: 100 } ) );
		v.fill( jobstatsMsg( { runs: 3, ts: 200 } ) );
		expect( v.snapshot( v.modelKey ).evtemplate.windowed.runs ).toBe( 8 );
		// Advance wall-clock so sample A (ts = TS_BASE + 100) ages out.
		v._pruneExpired( ( TS_BASE + 150 + RETENTION_S ) * 1000 );
		expect( v.snapshot( v.modelKey ).evtemplate.windowed.runs ).toBe( 3 );
		// Age sample B out too → the identity vanishes from the model.
		v._pruneExpired( ( TS_BASE + 300 + RETENTION_S ) * 1000 );
		expect( v.snapshot( v.modelKey ).evtemplate ).toBeUndefined();
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
		const { latest } = v.snapshot( v.modelKey ).evtemplate;
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
		expect( v.snapshot( v.modelKey ) ).toEqual( {} );
	} );

	it( 'counts both records when consecutive sweeps share a timestamp', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { runs: 2, ts: 100 } ) );
		v.fill( jobstatsMsg( { runs: 7, ts: 100 } ) );
		expect( v.snapshot( v.modelKey ).evtemplate.windowed.runs ).toBe( 9 );
	} );

	it( 'ignores a non-jobstats message (VALUE not a positional array)', () => {
		const v = new JobstatsViewNode();
		const m = newMessage();
		m[ TYPE ] = TM_STRUCT;
		m[ VALUE ] = { hello: 'world' };
		expect( () => v.fill( m ) ).not.toThrow();
		expect( v.snapshot( v.modelKey ) ).toEqual( {} );
	} );

	it( "publishes the view model under a 'handlers' key on the view field", () => {
		const v = new JobstatsViewNode();
		const published = [];
		v.notify = ( key ) => published.push( [ key, v.view ] );
		v.fill( jobstatsMsg( { ts: 100 } ) );
		expect( published.length ).toBeGreaterThanOrEqual( 1 );
		expect( published[ 0 ][ 0 ] ).toBe( 'view' );
		expect( published[ 0 ][ 1 ].handlers.evtemplate ).toBeTruthy();
	} );

	it( 'snapshot() returns a FRESH series array each call (never the live reference)', () => {
		const v = new JobstatsViewNode();
		v.fill( jobstatsMsg( { ts: 100 } ) );
		const a = v.snapshot( v.modelKey ).evtemplate.series;
		const b = v.snapshot( v.modelKey ).evtemplate.series;
		expect( a ).not.toBe( b );
		expect( a ).toEqual( b );
	} );
} );

function tablestatsMsg( {
	ts = 1000,
	id = 'lab-7:kea.p3',
	backend = 'sqlite',
	verbs = {},
	purgeBehind = 0,
	walStalled = 0,
	fileBytes = 0,
	fileDiskBytes = 0,
	elapsedMs = 15000,
	from = 'tablestats.p0/tablestats',
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = TS_BASE + ts;
	m[ FROM ] = from;
	const v = [];
	v[ Tbl.IDENTITY ] = id;
	v[ Tbl.BACKEND ] = backend;
	v[ Tbl.VERBS ] = verbs;
	v[ Tbl.PURGE_BEHIND ] = purgeBehind;
	v[ Tbl.WAL_STALLED ] = walStalled;
	v[ Tbl.FILE_BYTES ] = fileBytes;
	v[ Tbl.ELAPSED_MS ] = elapsedMs;
	v[ Tbl.FILE_DISK_BYTES ] = fileDiskBytes;
	m[ VALUE ] = v;
	return m;
}

// calls, asked, answered, bytes, ms, max ms, errors
const row = ( ...r ) => r;

describe( 'TablestatsViewNode', () => {
	it( 'carries the worker FROM names on each sample', () => {
		const v = new TablestatsViewNode();
		v.fill(
			tablestatsMsg( {
				ts: 115,
				from: 'tablestats.p0/flame-builder.p3/tablestats',
			} )
		);
		v.fill( tablestatsMsg( { ts: 130 } ) );
		expect(
			v
				.snapshot( v.modelKey )
				[ 'lab-7:kea.p3' ].series.map( ( s ) => s.worker )
		).toEqual( [ 'flame-builder.p3', '' ] );
	} );

	it( 'counts every operation, upkeep included, into one ops rate', () => {
		const v = new TablestatsViewNode();
		v.fill(
			tablestatsMsg( {
				verbs: {
					MGET: row( 9, 40, 31, 0, 18, 6.5, 0 ),
					PURGE: row( 2, 10000, 4210, 0, 30, 21, 0 ),
					CHECKPOINT: row( 1, 3712, 3700, 0, 12, 12, 0 ),
				},
				elapsedMs: 3000,
			} )
		);
		const s = v.snapshot( v.modelKey )[ 'lab-7:kea.p3' ].series.at( -1 );
		expect( s.opsRate ).toBe( 4 );
		expect( s.opRates.MGET ).toBe( 3 );
		expect( s.missRate ).toBe( 3 );
		expect( s.meanMs ).toBe( 5 );
		expect( s.maxMs ).toBe( 21 );
		expect( s.purgedDelta ).toBe( 4210 );
		expect( s.walWritten ).toBe( 3700 );
		expect( s.walFrames ).toBe( 3712 );
	} );

	it( 'reads a missing operation as zeros and no reads as no hit rate', () => {
		const v = new TablestatsViewNode();
		v.fill(
			tablestatsMsg( {
				verbs: { SADD: row( 3, 12, 12, 940, 1.5, 0.75, 1 ) },
			} )
		);
		const t = v.snapshot( v.modelKey )[ 'lab-7:kea.p3' ];
		expect( t.series.at( -1 ).missRate ).toBe( 0 );
		expect( t.series.at( -1 ).opRates.GET ).toBeUndefined();
		expect( t.windowed.hitPct ).toBeNull();
		expect( t.windowed.errors ).toBe( 1 );
		expect( Number.isNaN( t.windowed.meanMs ) ).toBe( false );
	} );

	it( 'sums the window per operation and in total, and takes levels from the newest', () => {
		const v = new TablestatsViewNode();
		v.fill(
			tablestatsMsg( {
				ts: 100,
				verbs: { GET: row( 4, 4, 3, 0, 8, 3.5, 0 ) },
				fileBytes: 4096,
				purgeBehind: 1,
			} )
		);
		v.fill(
			tablestatsMsg( {
				ts: 115,
				verbs: { GET: row( 6, 6, 6, 0, 4, 1.25, 2 ) },
				fileBytes: 8192,
				fileDiskBytes: 12288,
				walStalled: 3,
			} )
		);
		const t = v.snapshot( v.modelKey )[ 'lab-7:kea.p3' ];
		expect( t.windowed.ops ).toBe( 10 );
		expect( t.windowed.hitPct ).toBe( 90 );
		expect( t.windowed.meanMs ).toBe( 1.2 );
		expect( t.windowed.maxMs ).toBe( 3.5 );
		expect( t.windowed ).not.toHaveProperty( 'verbs' );
		expect( t.latest ).toEqual( {
			ts: TS_BASE + 115,
			fileBytes: 8192,
			fileDiskBytes: 12288,
			purgeBehind: 0,
			walStalled: 3,
		} );
		expect( t.backend ).toBe( 'sqlite' );
	} );

	it( 'keeps each sample to its scalars and its operation rates', () => {
		const v = new TablestatsViewNode();
		v.fill(
			tablestatsMsg( {
				verbs: {
					GET: row( 4, 4, 3, 0, 8, 3.5, 0 ),
					MSET: row( 2, 2, 2, 940, 6, 4.25, 1 ),
				},
				fileBytes: 4471,
				fileDiskBytes: 8192,
				elapsedMs: 2000,
			} )
		);
		const s = v.snapshot( v.modelKey )[ 'lab-7:kea.p3' ].series.at( -1 );
		expect( Object.keys( s ).sort() ).toEqual(
			[
				'ts',
				'worker',
				'elapsed',
				'opsDelta',
				'readKeys',
				'hitKeys',
				'errorsDelta',
				'purgedDelta',
				'walWritten',
				'walFrames',
				'ms',
				'maxMs',
				'fileBytes',
				'fileDiskBytes',
				'opRates',
				'opsRate',
				'missRate',
				'errorsRate',
				'meanMs',
			].sort()
		);
		expect( s.ms ).toBe( 14 );
		expect( s.maxMs ).toBe( 4.25 );
		expect( s.opRates ).toEqual( { GET: 2, MSET: 1 } );
		expect( s.fileBytes ).toBe( 4471 );
		expect( s.fileDiskBytes ).toBe( 8192 );
	} );

	it( 'keeps a slot the record says does not apply as null', () => {
		const v = new TablestatsViewNode();
		v.fill(
			tablestatsMsg( {
				backend: 'memcache',
				verbs: { GET: row( 4, 4, 3, 0, 8, 3.5, 0 ) },
				purgeBehind: null,
				walStalled: null,
				fileBytes: null,
				fileDiskBytes: null,
			} )
		);
		const t = v.snapshot( v.modelKey )[ 'lab-7:kea.p3' ];
		expect( t.latest ).toEqual( {
			ts: TS_BASE + 1000,
			fileBytes: null,
			fileDiskBytes: null,
			purgeBehind: null,
			walStalled: null,
		} );
		expect( t.series.at( -1 ).fileBytes ).toBeNull();
		expect( t.series.at( -1 ).fileDiskBytes ).toBeNull();
	} );

	it( 'reads an idle frame, an empty VERBS array, as zeros without NaN', () => {
		const v = new TablestatsViewNode();
		v.fill( tablestatsMsg( { verbs: [] } ) );
		const t = v.snapshot( v.modelKey )[ 'lab-7:kea.p3' ];
		const s = t.series.at( -1 );
		expect( t.windowed.ops ).toBe( 0 );
		expect( s.missRate ).toBe( 0 );
		expect( s.meanMs ).toBe( 0 );
		expect( t.windowed.hitPct ).toBeNull();
		expect( t.windowed.meanMs ).toBeNull();
		expect( t.windowed.maxMs ).toBeNull();
		for ( const n of [
			...Object.values( s ).filter( ( x ) => 'number' === typeof x ),
			...Object.values( t.windowed ).filter(
				( x ) => 'number' === typeof x
			),
		] ) {
			expect( Number.isNaN( n ) ).toBe( false );
		}
	} );

	it( 'sums upkeep across the window and keeps the longest call a max', () => {
		const v = new TablestatsViewNode();
		v.fill(
			tablestatsMsg( {
				ts: 100,
				verbs: {
					GET: row( 4, 4, 3, 0, 8, 3.5, 0 ),
					PURGE: row( 1, 50, 41, 0, 2, 2, 0 ),
					CHECKPOINT: row( 1, 70, 66, 0, 3, 3, 0 ),
				},
			} )
		);
		v.fill(
			tablestatsMsg( {
				ts: 115,
				verbs: {
					GET: row( 6, 6, 6, 0, 4, 1.25, 0 ),
					PURGE: row( 1, 50, 9, 0, 2, 2, 0 ),
					CHECKPOINT: row( 1, 30, 24, 0, 3, 3, 0 ),
				},
			} )
		);
		const w = v.snapshot( v.modelKey )[ 'lab-7:kea.p3' ].windowed;
		expect( w.maxMs ).toBe( 3.5 );
		expect( w.meanMs ).toBe( 22 / 14 );
		expect( w.purged ).toBe( 50 );
		expect( w.walWritten ).toBe( 90 );
		expect( w.walFrames ).toBe( 100 );
	} );

	it( 'shrinks the window sums as samples age out', () => {
		const v = new TablestatsViewNode();
		v.fill(
			tablestatsMsg( {
				ts: 100,
				verbs: { GET: row( 4, 4, 4, 0, 1, 1, 0 ) },
			} )
		);
		v.fill(
			tablestatsMsg( {
				ts: 200,
				verbs: { GET: row( 3, 3, 3, 0, 1, 1, 0 ) },
			} )
		);
		v._pruneExpired( ( TS_BASE + 150 + RETENTION_S ) * 1000 );
		expect( v.snapshot( v.modelKey )[ 'lab-7:kea.p3' ].windowed.ops ).toBe(
			3
		);
	} );

	it( "publishes under a 'tables' key", () => {
		const v = new TablestatsViewNode();
		const published = [];
		v.notify = ( key ) => published.push( [ key, v.view ] );
		v.fill( tablestatsMsg() );
		expect( published[ 0 ][ 1 ].tables[ 'lab-7:kea.p3' ] ).toBeTruthy();
	} );
} );

describe( 'ProbeStreamViewNode dump', () => {
	it( 'dumpNode omits the view and the entries, keeps the bridge', () => {
		const v = new WidgetProbeView();
		v.fill( widgetMsg( { id: 'dump-8812', label: 'dump', weight: 8812 } ) );
		const dump = v.dumpNode();

		expect( v.view.widgets[ 'dump-8812' ].label ).toBe( 'dump' );
		expect( dump ).not.toHaveProperty( 'view' );
		expect( dump ).not.toHaveProperty( 'entries' );
		expect( dump ).toHaveProperty( 'registrations' );
		expect( dump ).toHaveProperty( 'setStateCache' );
		v.removeNode();
	} );
} );
