import { backlogTotal } from '../backlogTotal';

const HEAD = 1786540928;

it( "sums each reader's latest backlog (per-READER lag, no source dedup)", () => {
	expect(
		backlogTotal(
			{
				r1: { source: 'jobs.p0', latest: { ts: HEAD, backlog: 40960 } },
				r2: { source: 'jobs.p0', latest: { ts: HEAD, backlog: 20480 } },
				r3: { source: 'firehose.p0', latest: { ts: HEAD, backlog: 0 } },
			},
			HEAD
		)
	).toBe( 61440 );
} );

it( 'yields 0 for an empty, null, or latest-less consumers map', () => {
	expect( backlogTotal( {}, HEAD ) ).toBe( 0 );
	expect( backlogTotal( null, HEAD ) ).toBe( 0 );
	expect( backlogTotal( { r1: { source: 'jobs.p0' } }, HEAD ) ).toBe( 0 );
} );

// The card is a CURRENT gauge. A reader that died while behind keeps its last
// sample, and the dashboard's 24h replay re-stamps every entry as freshly seen
// (liveness is measured from INGEST time, not the record's), so three readers
// dead for 17 hours reported 528 MB of debt nobody was working off — while
// `wp nodes status` showed every live reader 0B behind.
it( 'ignores a reader whose newest sample is stale', () => {
	const consumers = {
		live: { source: 'jobs.p0', latest: { ts: HEAD - 10, backlog: 1024 } },
		dead: {
			source: 'firehose.p0',
			latest: { ts: HEAD - 17 * 3600, backlog: 486539264 },
		},
	};
	expect( backlogTotal( consumers, HEAD ) ).toBe( 1024 );
} );

it( 'drops a reader 61s behind the head and keeps one 30s behind', () => {
	const consumers = {
		fresh: { source: 'jobs.p0', latest: { ts: HEAD - 30, backlog: 2048 } },
		stale: { source: 'jobs.p0', latest: { ts: HEAD - 61, backlog: 77777 } },
	};
	expect( backlogTotal( consumers, HEAD ) ).toBe( 2048 );
} );

it( 'never counts a sample with no ts, because the card shows only live debt', () => {
	expect( backlogTotal( { r: { latest: { backlog: 512 } } }, HEAD ) ).toBe(
		0
	);
} );

it( 'skips a reader that names no source, which no chart plots either', () => {
	expect(
		backlogTotal(
			{
				nameless: { source: '', latest: { ts: HEAD, backlog: 7777 } },
				r1: { source: 'jobs.p2', latest: { ts: HEAD, backlog: 3131 } },
			},
			HEAD
		)
	).toBe( 3131 );
} );
