import { render } from '@testing-library/react';
import SummaryCards from '../SummaryCards';

const topo = ( name, o = {} ) => ( {
	name,
	active: o.active ?? true,
	num_partitions: o.num_partitions ?? 1,
	health: o.health ?? 'ok',
	status: o.workers ? { workers: o.workers } : null,
} );
const wk = ( partition, state = 'live' ) => ( { partition, state } );
const NOW = 1786540928;
const card = ( c, mod ) =>
	c.querySelector( `.nodes-card--${ mod }` ).textContent;

function renderCards( props = {} ) {
	const base = {
		topologies: [
			topo( 'a', { workers: [ wk( 0 ) ] } ),
			topo( 'b', { workers: [ wk( 0 ) ] } ),
		],
		readRate: 1.2 * 1024 * 1024,
		writeRate: 1.6 * 1024 * 1024,
		logPartitions: 11,
		consumers: {},
	};
	return render( <SummaryCards { ...base } { ...props } /> );
}

it( 'marks every fleet metric as a canonical card surface', () => {
	const { container } = renderCards();
	const cards = [ ...container.querySelectorAll( '.nodes-card' ) ];

	expect( cards ).toHaveLength( 12 );
	expect(
		cards.every( ( item ) =>
			item.classList.contains( 'newspack-nodes-card' )
		)
	).toBe( true );
} );

it( 'shows the topology + active counts', () => {
	const { container } = renderCards();
	expect( card( container, 'topologies' ) ).toContain( '2' );
	expect( card( container, 'topologies' ) ).toContain( '2 active' );
} );

it( 'shows workers up against the CONFIGURED total (not reporting workers)', () => {
	const { container } = renderCards( {
		topologies: [
			topo( 'a', { num_partitions: 5, workers: [ wk( 0 ) ] } ),
		],
	} );
	expect( card( container, 'workers' ) ).toContain( '1 / 5' );
} );

it( 'shows the on-disk log-partition count', () => {
	const { container } = renderCards();
	expect( card( container, 'partitions' ) ).toContain( '11' );
} );

it( 'shows "all systems ok" when healthy, and the worst count otherwise', () => {
	expect( card( renderCards().container, 'health' ) ).toContain(
		'all systems ok'
	);
	const sick = renderCards( {
		topologies: [
			topo( 'a', { health: 'stalled' } ),
			topo( 'b', { health: 'behind' } ),
		],
	} );
	expect( card( sick.container, 'health' ) ).toContain( '1 stalled' );
	expect(
		sick.container.querySelector( '.nodes-card--health-stalled' )
	).toBeTruthy();
} );

it( 'formats the global read and write rates', () => {
	const { container } = renderCards();
	expect( card( container, 'read' ) ).toContain( '1.2 MB/s' );
	expect( card( container, 'write' ) ).toContain( '1.6 MB/s' );
} );

it( 'shows the global produced message rate from the probe consumers', () => {
	// Two distinct sources, each one reader; latest msgRate 7 + 3 = 10/s.
	const { container } = renderCards( {
		consumers: {
			r1: { source: 'firehose.p0', latest: { ts: NOW - 4, msgRate: 7 } },
			r2: { source: 'requests.p0', latest: { ts: NOW - 4, msgRate: 3 } },
		},
	} );
	expect( card( container, 'msgrate' ) ).toContain( '10/s' );
} );

it( 'shows average and total offsetlog cache size from the probe consumers', () => {
	const { container } = renderCards( {
		consumers: {
			'a.p0': {
				source: 'a.p0',
				latest: { ts: NOW - 4, cacheSize: 1000 },
			},
			'b.p0': {
				source: 'b.p0',
				latest: { ts: NOW - 4, cacheSize: 3000 },
			},
		},
	} );
	expect( card( container, 'cache-total' ) ).toContain( 'Total Cache' );
	expect( card( container, 'cache-avg' ) ).toContain( 'Avg Cache' );
} );

it( 'sums the current backlog across readers from the probe consumers', () => {
	// Per-READER lag: two readers of one source are two distinct backlogs.
	const { container } = renderCards( {
		consumers: {
			r1: { source: 'jobs.p0', latest: { ts: NOW - 4, backlog: 40960 } },
			r2: { source: 'jobs.p0', latest: { ts: NOW - 4, backlog: 20480 } },
			r3: { source: 'firehose.p0', latest: { ts: NOW - 4, backlog: 0 } },
		},
	} );
	expect( card( container, 'backlog' ) ).toContain( '60 KB' );
	expect( card( container, 'backlog' ) ).toContain( 'Backlog' );
} );

const skewedReaders = () => ( {
	head: {
		source: 'requests.p0',
		latest: { ts: NOW, msgRate: 10, backlog: 1024, cacheSize: 1024 },
	},
	fresh: {
		source: 'jobs.p0',
		latest: { ts: NOW - 30, msgRate: 27, backlog: 3072, cacheSize: 3072 },
	},
	stale: {
		source: 'firehose.p0',
		latest: { ts: NOW - 61, msgRate: 51000, backlog: 9e8, cacheSize: 9e8 },
	},
} );

it.each( [
	[ 'ten minutes behind', -600000 ],
	[ 'ten minutes ahead of', 600000 ],
] )(
	'judges every live card against the newest sample, not a browser clock %s the workers',
	( _label, skewMs ) => {
		const clock = jest
			.spyOn( Date, 'now' )
			.mockReturnValue( NOW * 1000 + skewMs );
		try {
			const { container } = renderCards( { consumers: skewedReaders() } );
			expect( card( container, 'msgrate' ) ).toContain( '37/s' );
			expect( card( container, 'backlog' ) ).toContain( '4 KB' );
			expect( card( container, 'cache-total' ) ).toContain( '4 KB' );
			expect( card( container, 'cache-avg' ) ).toContain( '2 KB' );
		} finally {
			clock.mockRestore();
		}
	}
);

it( 'formats the 24h produced messages + bytes from the probe consumers', () => {
	const series = [
		{ ts: 0, msgs: 500, bytes: 5000 },
		{ ts: 15, msgs: 1000, bytes: 10000 },
	];
	const { container } = renderCards( {
		consumers: { r1: { source: 's', series } },
	} );
	// Σ 1500 msgs; Σ 15000 B ≈ 15 KB (decimal dropped ≥10).
	expect( card( container, 'messages' ) ).toContain( '1.5K' );
	expect( card( container, 'bytes' ) ).toContain( '15 KB' );
} );
