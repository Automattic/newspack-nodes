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
	CURSOR_SEG,
	CURSOR_OFF,
	END_SEG,
	END_SIZE,
	DISTANCE,
	MSGS,
	END_BYTES,
	CACHE_SIZE,
} from '../../../runtime/probe-record';

// Build a probe record TM_STRUCT message: a lean POSITIONAL Probe_Record VALUE,
// with the snapshot instant carried in the Message TIMESTAMP (not in VALUE).
function probeMsg( {
	ts = 1000,
	reader = 'firehose.p0',
	source = 'firehose.p0',
	distance = 0,
	msgs = 0,
	endBytes = 0,
	cacheSize = 0,
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ TIMESTAMP ] = ts;
	const v = [];
	v[ SOURCE ] = source;
	v[ READER ] = reader;
	v[ CURSOR_SEG ] = 0;
	v[ CURSOR_OFF ] = 0;
	v[ END_SEG ] = 0;
	v[ END_SIZE ] = 0;
	v[ DISTANCE ] = distance;
	v[ MSGS ] = msgs;
	v[ END_BYTES ] = endBytes;
	v[ CACHE_SIZE ] = cacheSize;
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

	it( 'computes msgs-rate from consecutive msgs deltas over the ts gap', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: 1000, ts: 100 } ) );
		v.fill( probeMsg( { msgs: 4000, ts: 103 } ) ); // +3000 over 3s = 1000 msg/s
		expect( v.snapshot()[ 'firehose.p0' ].latest.msgRate ).toBe( 1000 );
	} );

	it( 'computes byte-rate from consecutive END_BYTES deltas over the ts gap', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { endBytes: 1000, ts: 100 } ) );
		v.fill( probeMsg( { endBytes: 4000, ts: 103 } ) ); // +3000 over 3s = 1000 B/s
		expect( v.snapshot()[ 'firehose.p0' ].latest.byteRate ).toBe( 1000 );
	} );

	it( 'treats an END_BYTES drop (segment GC) as byte-rate 0, never negative', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { endBytes: 9000, ts: 100 } ) );
		v.fill( probeMsg( { endBytes: 200, ts: 115 } ) ); // GC dropped old segments
		expect( v.snapshot()[ 'firehose.p0' ].latest.byteRate ).toBe( 0 );
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

	it( 'treats a msgs DROP (worker restart resets the counter) as rate 0, never negative', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: 9000, ts: 100 } ) );
		v.fill( probeMsg( { msgs: 200, ts: 115 } ) ); // per-process counter reset
		expect( v.snapshot()[ 'firehose.p0' ].latest.msgRate ).toBe( 0 );
	} );

	it( 'the first sample for a consumer has rate 0 (no prior to delta against)', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { msgs: 5000, ts: 100 } ) );
		expect( v.snapshot()[ 'firehose.p0' ].latest.msgRate ).toBe( 0 );
	} );

	it( 'keeps a bounded rate+backlog series per consumer (ring-capped)', () => {
		const v = new TopicProbeViewNode( 3 ); // cap = 3 samples
		for ( let i = 0; i < 6; i++ ) {
			v.fill( probeMsg( { msgs: i * 1000, ts: 100 + i } ) );
		}
		const c = v.snapshot()[ 'firehose.p0' ];
		expect( c.series.length ).toBe( 3 );
		expect( c.series[ c.series.length - 1 ].ts ).toBe( 105 );
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
			v.fill( probeMsg( { distance: 100, ts: 100 } ) ); // leading edge → publishes
			expect( published.length ).toBe( 1 );
			v.fill( probeMsg( { distance: 999, ts: 101 } ) ); // within window → deferred
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
		expect( a ).not.toBe( b ); // distinct identities → React memo sees a change
		expect( a ).toEqual( b ); // same contents
	} );

	it( 'evicts a consumer not seen within the liveness TTL (no unbounded growth)', () => {
		jest.useFakeTimers();
		try {
			const v = new TopicProbeViewNode( undefined, 1000 ); // ttlMs = 1s
			v.fill( probeMsg( { reader: 'gone.p0', ts: 100 } ) );
			expect( v.snapshot()[ 'gone.p0' ] ).toBeTruthy();
			// LIVE stream: alive.p0 keeps arriving at small gaps while gone.p0 goes
			// silent. The small inter-fill gaps (< ttlMs) keep the stream "live", so
			// the outage re-baseline never triggers and gone.p0 evicts on its own TTL.
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
			// Overview tab hidden > TTL: the stream was closed, no frames arrived,
			// every consumer's _lastSeen froze. The FIRST frame on reconnect must
			// NOT wipe the pre-existing consumers — the outage is not their death.
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
			// keepalive.p0 advances _lastFill 500ms later (no outage, gap < ttl), so
			// when the outage hits, dead.p0's last activity is OLDER than _lastFill.
			jest.advanceTimersByTime( 500 );
			v.fill( probeMsg( { reader: 'keepalive.p0', ts: 105 } ) ); // real-time 500
			// Outage: gap 1500 > ttl. A blanket re-baseline would hand dead.p0 a fresh
			// full lease here; the refine must only shift it by the outage, not reset it.
			jest.advanceTimersByTime( 1500 );
			v.fill( probeMsg( { reader: 'live.p0', ts: 110 } ) ); // real-time 2000
			// One more outage-free fill 600ms later: dead.p0 (silent since real-time 0,
			// ~2600ms — way past ttl) must now be gone; the still-producing ones stay.
			jest.advanceTimersByTime( 600 );
			v.fill( probeMsg( { reader: 'live.p0', ts: 111 } ) ); // real-time 2600
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
			expect( published.length ).toBe( 1 ); // trailing flush was cancelled
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
