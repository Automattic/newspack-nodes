import { TopicProbeViewNode } from '../topicProbeView';
import { newMessage, TYPE, VALUE, TM_STRUCT } from '../../../runtime/message';

// Build a probe record TM_STRUCT message (the shape Consumer_Node::probe_stats()
// emits, with ts/host added by TopicProbe). `overrides` carries the snake_case
// wire keys directly (object-literal keys, not destructured locals).
function probeMsg( overrides = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ VALUE ] = {
		ts: 1000,
		consumer: 'firehose:consumer',
		offset_dir: 'firehose.p0',
		source: 'firehose.p0',
		worker_type: 'combined',
		bytes_read: 0,
		bytes_behind: 0,
		...overrides,
	};
	return m;
}

describe( 'TopicProbeViewNode', () => {
	it( 'indexes samples by offset_dir, carrying worker_type/source/consumer', () => {
		const v = new TopicProbeViewNode();
		v.fill(
			probeMsg( { offset_dir: 'firehose.p0', worker_type: 'combined' } )
		);
		v.fill(
			probeMsg( { offset_dir: 'jobs.p0', worker_type: 'job-worker' } )
		);
		const snap = v.snapshot();
		expect( Object.keys( snap ).sort() ).toEqual( [
			'firehose.p0',
			'jobs.p0',
		] );
		expect( snap[ 'firehose.p0' ].worker_type ).toBe( 'combined' );
		expect( snap[ 'firehose.p0' ].source ).toBe( 'firehose.p0' );
	} );

	it( 'computes byte-rate from consecutive bytes_read deltas over the ts gap', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { bytes_read: 1000, ts: 100 } ) );
		v.fill( probeMsg( { bytes_read: 4000, ts: 103 } ) ); // +3000 over 3s = 1000 B/s
		const c = v.snapshot()[ 'firehose.p0' ];
		expect( c.latest.rate ).toBe( 1000 );
	} );

	it( 'reports the latest bytes_behind as the backlog', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { bytes_behind: 500, ts: 100 } ) );
		v.fill( probeMsg( { bytes_behind: 7800, ts: 115 } ) );
		expect( v.snapshot()[ 'firehose.p0' ].latest.backlog ).toBe( 7800 );
	} );

	it( 'treats a bytes_read DROP (worker restart resets the counter) as rate 0, never negative', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { bytes_read: 9000, ts: 100 } ) );
		// Worker restarted: bytes_read is per-process, so it resets below the prior.
		v.fill( probeMsg( { bytes_read: 200, ts: 115 } ) );
		expect( v.snapshot()[ 'firehose.p0' ].latest.rate ).toBe( 0 );
	} );

	it( 'the first sample for a consumer has rate 0 (no prior to delta against)', () => {
		const v = new TopicProbeViewNode();
		v.fill( probeMsg( { bytes_read: 5000, ts: 100 } ) );
		expect( v.snapshot()[ 'firehose.p0' ].latest.rate ).toBe( 0 );
	} );

	it( 'keeps a bounded rate+backlog series per consumer (ring-capped)', () => {
		const v = new TopicProbeViewNode( 3 ); // cap = 3 samples
		for ( let i = 0; i < 6; i++ ) {
			v.fill( probeMsg( { bytes_read: i * 1000, ts: 100 + i } ) );
		}
		const c = v.snapshot()[ 'firehose.p0' ];
		expect( c.series.length ).toBe( 3 );
		// Newest sample's backlog/ts reflect the last record.
		expect( c.series[ c.series.length - 1 ].ts ).toBe( 105 );
	} );

	it( 'ignores a non-probe message (no offset_dir) without throwing', () => {
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
			v.fill( probeMsg( { bytes_behind: 100, ts: 100 } ) ); // leading edge → publishes
			expect( published.length ).toBe( 1 );
			v.fill( probeMsg( { bytes_behind: 999, ts: 101 } ) ); // within window → deferred
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
			v.fill( probeMsg( { offset_dir: 'gone.p0', ts: 100 } ) );
			expect( v.snapshot()[ 'gone.p0' ] ).toBeTruthy();
			jest.advanceTimersByTime( 2000 ); // past the TTL
			// A live frame from a DIFFERENT consumer triggers the eviction sweep.
			v.fill( probeMsg( { offset_dir: 'alive.p0', ts: 200 } ) );
			expect( v.snapshot()[ 'gone.p0' ] ).toBeUndefined();
			expect( v.snapshot()[ 'alive.p0' ] ).toBeTruthy();
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
		// At least one publish with the 'view' key carrying the consumers snapshot.
		expect( published.length ).toBeGreaterThanOrEqual( 1 );
		expect( published[ 0 ][ 0 ] ).toBe( 'view' );
		expect( published[ 0 ][ 1 ].consumers[ 'firehose.p0' ] ).toBeTruthy();
	} );
} );
