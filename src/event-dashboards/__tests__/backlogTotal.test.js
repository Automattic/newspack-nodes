import { backlogTotal } from '../backlogTotal';

it( "sums each reader's latest backlog (per-READER lag, no source dedup)", () => {
	expect(
		backlogTotal( {
			r1: { source: 'jobs.p0', latest: { backlog: 40960 } },
			r2: { source: 'jobs.p0', latest: { backlog: 20480 } },
			r3: { source: 'firehose.p0', latest: { backlog: 0 } },
		} )
	).toBe( 61440 );
} );

it( 'yields 0 for an empty, null, or latest-less consumers map', () => {
	expect( backlogTotal( {} ) ).toBe( 0 );
	expect( backlogTotal( null ) ).toBe( 0 );
	expect( backlogTotal( { r1: { source: 'jobs.p0' } } ) ).toBe( 0 );
} );
