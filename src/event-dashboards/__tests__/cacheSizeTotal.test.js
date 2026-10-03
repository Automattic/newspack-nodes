import { cacheSizeTotal } from '../cacheSizeTotal';

const HEAD = 1786540928;
const reader = ( source, cacheSize, age = 5 ) => ( {
	source,
	latest: { ts: HEAD - age, cacheSize },
} );

describe( 'cacheSizeTotal', () => {
	it( 'sums each reader latest cache size', () => {
		const consumers = {
			'a.p0': reader( 'a.p0', 1000 ),
			'b.p0': reader( 'b.p0', 3000 ),
		};
		expect( cacheSizeTotal( consumers, HEAD ) ).toBe( 4000 );
	} );

	it( 'counts every reader (offsetlogs are per-reader, not deduped by source)', () => {
		// Two readers of ONE source each keep their OWN offsetlog → both counted.
		const consumers = {
			r1: reader( 'firehose.p0', 500 ),
			r2: reader( 'firehose.p0', 1500 ),
		};
		expect( cacheSizeTotal( consumers, HEAD ) ).toBe( 2000 );
	} );

	it( 'leaves a reader 61s behind the head out of the total', () => {
		const consumers = {
			fresh: reader( 'a.p0', 2400, 30 ),
			stale: reader( 'b.p0', 9100, 61 ),
		};
		expect( cacheSizeTotal( consumers, HEAD ) ).toBe( 2400 );
	} );

	it( 'skips a reader that names no source', () => {
		const consumers = {
			nameless: reader( '', 9000 ),
			r1: reader( 'jobs.p2', 1300 ),
			r2: reader( 'jobs.p3', 700 ),
		};
		expect( cacheSizeTotal( consumers, HEAD ) ).toBe( 2000 );
	} );

	it( 'is zero for no consumers', () => {
		expect( cacheSizeTotal( {}, HEAD ) ).toBe( 0 );
		expect( cacheSizeTotal( null, HEAD ) ).toBe( 0 );
	} );
} );
