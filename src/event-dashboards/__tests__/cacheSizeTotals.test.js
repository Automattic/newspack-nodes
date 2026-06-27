import { cacheSizeTotals } from '../cacheSizeTotals';

describe( 'cacheSizeTotals', () => {
	it( 'sums and averages each reader latest cache size', () => {
		const consumers = {
			'a.p0': { source: 'a.p0', latest: { cacheSize: 1000 } },
			'b.p0': { source: 'b.p0', latest: { cacheSize: 3000 } },
		};
		expect( cacheSizeTotals( consumers ) ).toEqual( {
			total: 4000,
			avg: 2000,
		} );
	} );

	it( 'counts every reader (offsetlogs are per-reader, not deduped by source)', () => {
		// Two readers of ONE source each keep their OWN offsetlog → both counted.
		const consumers = {
			r1: { source: 'firehose.p0', latest: { cacheSize: 500 } },
			r2: { source: 'firehose.p0', latest: { cacheSize: 1500 } },
		};
		expect( cacheSizeTotals( consumers ) ).toEqual( {
			total: 2000,
			avg: 1000,
		} );
	} );

	it( 'is zero for no consumers', () => {
		expect( cacheSizeTotals( {} ) ).toEqual( { total: 0, avg: 0 } );
		expect( cacheSizeTotals( null ) ).toEqual( { total: 0, avg: 0 } );
	} );
} );
