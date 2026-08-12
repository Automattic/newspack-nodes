import { backlogTotal } from '../backlogTotal';

const NOW = 1786540928;

it( "sums each reader's latest backlog (per-READER lag, no source dedup)", () => {
	expect(
		backlogTotal(
			{
				r1: { source: 'jobs.p0', latest: { ts: NOW, backlog: 40960 } },
				r2: { source: 'jobs.p0', latest: { ts: NOW, backlog: 20480 } },
				r3: { source: 'firehose.p0', latest: { ts: NOW, backlog: 0 } },
			},
			NOW
		)
	).toBe( 61440 );
} );

it( 'yields 0 for an empty, null, or latest-less consumers map', () => {
	expect( backlogTotal( {} ) ).toBe( 0 );
	expect( backlogTotal( null ) ).toBe( 0 );
	expect( backlogTotal( { r1: { source: 'jobs.p0' } } ) ).toBe( 0 );
} );

// The card is a CURRENT gauge. A reader that died while behind keeps its last
// sample, and the dashboard's 24h replay re-stamps every entry as freshly seen
// (liveness is measured from INGEST time, not the record's), so three readers
// dead for 17 hours reported 528 MB of debt nobody was working off — while
// `wp nodes status` showed every live reader 0B behind.
it( 'ignores a reader whose newest sample is stale', () => {
	const consumers = {
		live: { source: 'jobs.p0', latest: { ts: NOW - 10, backlog: 1024 } },
		dead: {
			source: 'firehose.p0',
			latest: { ts: NOW - 17 * 3600, backlog: 486539264 },
		},
	};
	expect( backlogTotal( consumers, NOW ) ).toBe( 1024 );
} );

it( 'counts a sample with no ts, so a probe that omits it is not silently zeroed', () => {
	expect( backlogTotal( { r: { latest: { backlog: 512 } } }, NOW ) ).toBe(
		512
	);
} );
