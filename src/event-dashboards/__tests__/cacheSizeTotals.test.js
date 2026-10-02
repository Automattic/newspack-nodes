import { cacheSizeTotals } from '../cacheSizeTotals';

const HEAD = 1786540928;
const reader = ( source, cacheSize, age = 5 ) => ( {
	source,
	latest: { ts: HEAD - age, cacheSize },
} );

describe( 'cacheSizeTotals', () => {
	it( 'sums and averages each reader latest cache size', () => {
		const consumers = {
			'a.p0': reader( 'a.p0', 1000 ),
			'b.p0': reader( 'b.p0', 3000 ),
		};
		expect( cacheSizeTotals( consumers, HEAD ) ).toEqual( {
			total: 4000,
			avg: 2000,
		} );
	} );

	it( 'counts every reader (offsetlogs are per-reader, not deduped by source)', () => {
		// Two readers of ONE source each keep their OWN offsetlog → both counted.
		const consumers = {
			r1: reader( 'firehose.p0', 500 ),
			r2: reader( 'firehose.p0', 1500 ),
		};
		expect( cacheSizeTotals( consumers, HEAD ) ).toEqual( {
			total: 2000,
			avg: 1000,
		} );
	} );

	it( 'leaves a reader 61s behind the head out of both the total and the average', () => {
		const consumers = {
			fresh: reader( 'a.p0', 2400, 30 ),
			stale: reader( 'b.p0', 9100, 61 ),
		};
		expect( cacheSizeTotals( consumers, HEAD ) ).toEqual( {
			total: 2400,
			avg: 2400,
		} );
	} );

	it( 'is zero for no consumers', () => {
		expect( cacheSizeTotals( {}, HEAD ) ).toEqual( { total: 0, avg: 0 } );
		expect( cacheSizeTotals( null, HEAD ) ).toEqual( { total: 0, avg: 0 } );
	} );
} );
