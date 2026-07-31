import { render } from '@testing-library/react';
import SummaryCards from '../SummaryCards';

const topo = ( name, o = {} ) => ( {
	name,
	active: o.active ?? true,
	num_partitions: o.num_partitions ?? 1,
	health: o.health ?? 'ok',
	status: o.workers ? { workers: o.workers } : null,
} );
const wk = ( partition, status = 'running' ) => ( { partition, status } );
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
			r1: { source: 'firehose.p0', latest: { msgRate: 7 } },
			r2: { source: 'requests.p0', latest: { msgRate: 3 } },
		},
	} );
	expect( card( container, 'msgrate' ) ).toContain( '10/s' );
} );

it( 'shows average and total offsetlog cache size from the probe consumers', () => {
	const { container } = renderCards( {
		consumers: {
			'a.p0': { source: 'a.p0', latest: { cacheSize: 1000 } },
			'b.p0': { source: 'b.p0', latest: { cacheSize: 3000 } },
		},
	} );
	expect( card( container, 'cache-total' ) ).toContain( 'Total Cache' );
	expect( card( container, 'cache-avg' ) ).toContain( 'Avg Cache' );
} );

it( 'sums the current backlog across readers from the probe consumers', () => {
	// Per-READER lag: two readers of one source are two distinct backlogs.
	const { container } = renderCards( {
		consumers: {
			r1: { source: 'jobs.p0', latest: { backlog: 40960 } },
			r2: { source: 'jobs.p0', latest: { backlog: 20480 } },
			r3: { source: 'firehose.p0', latest: { backlog: 0 } },
		},
	} );
	expect( card( container, 'backlog' ) ).toContain( '60 KB' );
	expect( card( container, 'backlog' ) ).toContain( 'Backlog' );
} );

it( 'formats the 24h produced messages + bytes from the probe consumers', () => {
	const series = [
		{ ts: 0, msgRate: 0, byteRate: 0 },
		{ ts: 15, msgRate: 100, byteRate: 1000 },
	];
	const { container } = renderCards( {
		consumers: { r1: { source: 's', series } },
	} );
	// 100/s×15s=1500 msgs; 1000 B/s×15s=15000 B ≈ 15 KB (decimal dropped ≥10).
	expect( card( container, 'messages' ) ).toContain( '1.5K' );
	expect( card( container, 'bytes' ) ).toContain( '15 KB' );
} );
