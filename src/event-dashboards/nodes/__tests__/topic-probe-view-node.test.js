import { TopicProbeViewNode } from '../topic-probe-view-node';
import {
	newMessage,
	TYPE,
	TIMESTAMP,
	VALUE,
	TM_STRUCT,
} from '../../../runtime/message';
import {
	SOURCE,
	READER,
	DISTANCE,
	MSGS_DELTA,
	BYTES_READ_DELTA,
	CACHE_SIZE,
	ELAPSED_MS,
} from '../../../runtime/probe-record';

// Probe ts here is an OFFSET from a recent epoch base; absTs bypasses it.
const TS_BASE = Math.floor( Date.now() / 1000 ) - 10000;

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
	v[ SOURCE ] = source;
	v[ READER ] = reader;
	v[ DISTANCE ] = distance;
	v[ MSGS_DELTA ] = msgs;
	v[ BYTES_READ_DELTA ] = bytes;
	v[ CACHE_SIZE ] = cacheSize;
	v[ ELAPSED_MS ] = elapsedMs;
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
