import { globalMsgRate } from '../globalMsgRate';

describe( 'globalMsgRate', () => {
	it( 'sums each source’s latest msgRate across distinct sources', () => {
		const consumers = {
			r1: { source: 'firehose.p0', latest: { msgRate: 7 } },
			r2: { source: 'requests.p0', latest: { msgRate: 3 } },
		};
		expect( globalMsgRate( consumers ) ).toBe( 10 );
	} );

	it( 'does not double-count co-readers of one (per-partition) source', () => {
		// firehose.p0 read by two topologies: identical per-partition rate, so
		// dedup (max) to ONE — not 7 + 7.
		const consumers = {
			r1: { source: 'firehose.p0', latest: { msgRate: 7 } },
			r2: { source: 'firehose.p0', latest: { msgRate: 7 } },
		};
		expect( globalMsgRate( consumers ) ).toBe( 7 );
	} );

	it( 'sums across a topic’s distinct per-partition sources', () => {
		// firehose.p0 + firehose.p1 are SEPARATE sources → the topic total is
		// their sum, even though both are "firehose".
		const consumers = {
			r1: { source: 'firehose.p0', latest: { msgRate: 4 } },
			r2: { source: 'firehose.p1', latest: { msgRate: 6 } },
		};
		expect( globalMsgRate( consumers ) ).toBe( 10 );
	} );

	it( 'takes the max on a co-reader rate skew', () => {
		const consumers = {
			r1: { source: 'firehose.p0', latest: { msgRate: 4 } },
			r2: { source: 'firehose.p0', latest: { msgRate: 9 } },
		};
		expect( globalMsgRate( consumers ) ).toBe( 9 );
	} );

	it( 'ignores consumers with an empty source or no latest sample', () => {
		const consumers = {
			r1: { source: '', latest: { msgRate: 99 } },
			r2: { source: 'requests.p0' },
			r3: { source: 'firehose.p0', latest: { msgRate: 4 } },
		};
		expect( globalMsgRate( consumers ) ).toBe( 4 );
	} );

	it( 'returns 0 for empty / undefined consumers', () => {
		expect( globalMsgRate( {} ) ).toBe( 0 );
		expect( globalMsgRate( undefined ) ).toBe( 0 );
	} );
} );
