/**
 * The station's composed tabs against the pages they replace: each tab, on
 * its default layout (`tests/fixtures/station-layouts.json`, which PHPUnit
 * holds to `Composition::validate()`) and seeded sources, reads to a reader
 * of its role tree exactly as the page before it did. The snapshots were
 * recorded from the pages before their conversion and are the spec the
 * default layouts meet.
 *
 * The seam is the wire for every poll and the view node for every stream: a
 * test answers `dump_graph`, `topologies dump`, `summary` and `list_servers`
 * through the fake command wire, and sets each probe view's model as its
 * stream would.
 */

import { act, fireEvent, render } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { holdRouterCadence } from '@newspack-nodes/shared/test-utils/holdRouterCadence';
import { roleTree } from '@newspack-nodes/shared/test-utils/roleTree';
import { bucketsFrom } from '../../event-dashboards/__tests__/bucketTestUtils';
import { TopicProbeViewNode } from '../../event-dashboards/nodes/topic-probe-view-node';
import { JobstatsViewNode } from '../../event-dashboards/nodes/jobstats-view-node';
import { TablestatsViewNode } from '../../event-dashboards/nodes/tablestats-view-node';
import {
	OverviewTab,
	JobsTab,
	TablesTab,
} from '../../event-dashboards/stationTabs';
import { AggregatorTab } from '../../event-aggregator/AggregatorTab';
import { localizeStationPages } from './localizeStationPages';

/** The page's clock, so every age reads alike across both renders. */
const NOW_S = 1748960040;

class FakeEventSource {
	constructor( url ) {
		this.url = url;
	}
	addEventListener() {}
	close() {}
}

const DUMP_GRAPH = {
	timestamp: NOW_S,
	segment_size: 8 * 1024 * 1024,
	log_partitions: 7,
	workers: [
		{
			type: 'kakapo-7901',
			handler: 'kakapo-7901',
			partition: 0,
			started_at: NOW_S - 600,
			state: 'live',
			heartbeat_age: 3,
			inputs: [],
			outputs: [],
			inputs_status: [],
			outputs_status: [],
		},
	],
	logs: [
		{
			name: 'jobs.p0',
			segment_size: 8 * 1024 * 1024,
			partitions: [
				{
					partition: 0,
					segments: [ { id: 3, size: 81920, mtime: NOW_S - 9 } ],
					total_size: 81920,
					probe: { grown: 9000, elapsed_ms: 2000 },
				},
			],
		},
	],
	consumers: [
		{
			reader: 'kakapo-7901.jobs.p0',
			source: 'jobs.p0',
			partition: 0,
			bytes_read: 18350,
			elapsed_ms: 5000,
		},
	],
	graph: {
		'kakapo-7901': {
			nodes: [ { name: 'kakapo-7901', kind: 'logic' } ],
			edges: [],
		},
	},
};

const TOPOLOGIES = {
	topologies: [
		{
			name: 'kakapo-7901',
			source: 'user',
			active: true,
			num_partitions: 1,
		},
		{
			name: 'takahe-7902',
			source: 'stock',
			active: false,
			num_partitions: 2,
		},
	],
	user_dir: '/tmp/topologies',
};

const SUMMARY = {
	connected: 1,
	idle: 1,
	total: 3,
	server_now: NOW_S,
	unreadable: { 'weka-7903': 'it names no such include' },
};

const SERVERS = [
	{
		id: 'tui-7904',
		vault_id: 'tui-7904-vault',
		url: 'https://tui-7904.example.test',
		partitions: {
			0: {
				connected: true,
				last_response: NOW_S - 4,
				last_rtt: 42,
				last_connection_attempt: NOW_S - 300,
				last_sse_heartbeat: NOW_S - 2,
				last_http_code: 200,
			},
		},
		readers: [
			{
				stamp: 'logs:firehose.p0',
				partition: 0,
				cursor: '3:4096',
				distance: 2048,
			},
		],
	},
	{
		id: 'ruru-7905',
		vault_id: 'ruru-7905-vault',
		url: 'https://ruru-7905.example.test',
		partitions: {
			0: { connected: false, last_error: 'timeout', last_http_code: 504 },
			1: {
				connected: false,
				scheduled_reconnect_at: NOW_S + 9,
				last_connection_attempt: NOW_S - 6,
			},
		},
		readers: [],
	},
];

const REPLIES = {
	dump_graph: DUMP_GRAPH,
	dump: TOPOLOGIES,
	summary: SUMMARY,
	list_servers: SERVERS,
};

const reader = ( worker, msgs, backlog ) => ( {
	source: 'jobs.p0',
	latest: {
		ts: NOW_S - 20,
		msgRate: msgs,
		backlog: backlog * 2,
		cacheSize: backlog,
	},
	buckets: bucketsFrom( [
		{
			ts: NOW_S - 200,
			elapsed: 15,
			msgs: msgs * 15,
			bytes: msgs * 64 * 15,
			backlog,
			cacheSize: backlog / 2,
			worker,
		},
		{
			ts: NOW_S - 20,
			elapsed: 15,
			msgs: msgs * 30,
			bytes: msgs * 128 * 15,
			backlog: backlog * 2,
			cacheSize: backlog,
			worker,
		},
	] ),
} );

const TOPIC_PROBE = {
	consumers: {
		'kakapo-7901.jobs.p0': reader( 'kakapo-7901-31.p0', 7, 300 ),
		'kea-7906.firehose.p0': {
			...reader( 'kea-7906-32.p0', 11, 500 ),
			source: 'firehose.p0',
		},
	},
	partitions: {
		'logs:jobs.p0': {
			source: 'logs:jobs.p0',
			latest: { ts: NOW_S - 20, endBytes: 81920, diskBytes: 98304 },
			buckets: bucketsFrom( [
				{
					ts: NOW_S - 20,
					elapsed: 15,
					endBytes: 81920,
					diskBytes: 98304,
					worker: 'kakapo-7901-31.p0',
				},
			] ),
		},
	},
};

const handler = ( key, errors, status ) => ( {
	key,
	handler: key.split( ':' )[ 0 ],
	windowed: {
		runs: 12 + errors,
		errors,
		avgDurationMs: 210,
		maxDurationMs: 940,
		avgQueueMs: 33,
	},
	latest: {
		lastTs: NOW_S - 30,
		lastDurationMs: 250,
		lastStatus: status,
		lastMessage: `Job ${ key } ${ status }`,
	},
	buckets: bucketsFrom( [
		{
			ts: NOW_S - 20,
			elapsed: 15,
			runsDelta: 30,
			errorsDelta: errors,
			queueDelta: 30 * 33,
		},
	] ),
} );

const JOBSTATS = {
	handlers: {
		'cron:films': handler( 'cron:films', 5, 'error' ),
		evtemplate: handler( 'evtemplate', 0, 'success' ),
	},
};

const table = ( key, backend, errors ) => ( {
	key,
	backend,
	windowed: {
		ops: 240,
		hitPct: 87.5,
		meanMs: 1.25,
		maxMs: 9.75,
		errors,
		purged: 4210,
		walWritten: 3700,
		walFrames: 3712,
	},
	latest: {
		ts: NOW_S - 20,
		fileBytes: 8192,
		fileDiskBytes: 12288,
		purgeBehind: 0,
		walStalled: 0,
	},
	buckets: bucketsFrom(
		[ NOW_S - 35, NOW_S - 20 ].map( ( ts ) => ( {
			ts,
			elapsed: 15,
			opsDelta: 30,
			misses: 7.5,
			ms: 37.5,
			maxMs: 4.5,
			fileBytes: 8192,
			fileDiskBytes: 12288,
			'op:GET': 22.5,
			'op:MSET': 7.5,
			worker: 'kea-7906-32.p0',
		} ) )
	),
} );

const TABLESTATS = {
	tables: {
		'flame-stats:aggregate.p0': table(
			'flame-stats:aggregate.p0',
			'sqlite',
			0
		),
		'flame-stats:url.p0': table( 'flame-stats:url.p0', 'wpdb', 3 ),
	},
};

/**
 * Set every live view of `Class` to `model`, as its stream would.
 *
 * @param {Function} Class A probe view class.
 * @param {Object}   model Its model.
 */
function seedViews( Class, model ) {
	for ( const node of Core.nodes.values() ) {
		if ( node instanceof Class ) {
			node.setField( 'view', model );
		}
	}
}

/**
 * A page's tree with each axis date masked, since an axis dates its ticks in
 * the host's own zone.
 *
 * @param {Element} container The page.
 * @return {string} The tree.
 */
const tree = ( container ) =>
	roleTree( container ).replace( /\d+\/\d+ \d+:\d+/g, '<date>' );

/**
 * Render a page, answer its polls and seed its streams.
 *
 * @param {import('react').ReactElement} page The page.
 * @return {Promise<Element>} Its container.
 */
async function rendered( page ) {
	const { container } = render( page );
	for ( let tick = 0; tick < 4; tick++ ) {
		await act( async () => {
			Core.node( '_router' )?.fireCb();
		} );
	}
	await act( async () => {
		seedViews( TopicProbeViewNode, TOPIC_PROBE );
		seedViews( JobstatsViewNode, JOBSTATS );
		seedViews( TablestatsViewNode, TABLESTATS );
	} );
	return container;
}

let wire;

/**
 * How many times the wire carried one command.
 *
 * @param {string} verb The command's name.
 * @return {number} The count.
 */
const asked = ( verb ) =>
	wire.batches.flat().filter( ( m ) => verb === m[ VALUE ]?.name ).length;

beforeEach( () => {
	Core.reset();
	holdRouterCadence();
	window.localStorage.clear();
	jest.spyOn( Date, 'now' ).mockReturnValue( NOW_S * 1000 );
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	localizeStationPages();
	global.EventSource = FakeEventSource;
	wire = installFakeCommandWire(
		( m ) => REPLIES[ m[ VALUE ]?.name ] ?? null
	);
} );

afterEach( () => {
	jest.restoreAllMocks();
} );

it( 'reads the Overview tab as the Overview page read', async () => {
	const container = await rendered( <OverviewTab /> );
	expect( tree( container ) ).toMatchSnapshot();
} );

it( 'reads the Jobs tab as the Jobs page read', async () => {
	const container = await rendered( <JobsTab /> );
	expect( tree( container ) ).toMatchSnapshot();
} );

it( 'reads the Tables tab as the Tables page read', async () => {
	const container = await rendered( <TablesTab /> );
	expect( tree( container ) ).toMatchSnapshot();
} );

it( 'reads the Aggregator tab as the Aggregator page read', async () => {
	const container = await rendered( <AggregatorTab /> );
	expect( tree( container ) ).toMatchSnapshot();
} );

it( 'links the composed Overview to the console as the page before it did', async () => {
	const container = await rendered( <OverviewTab /> );
	const hrefs = Object.fromEntries(
		[ ...container.querySelectorAll( 'a' ) ].map( ( a ) => [
			a.textContent,
			a.getAttribute( 'href' ),
		] )
	);
	expect( hrefs[ '+ New Topology' ] ).toBe(
		'admin.php?page=newspack-nodes-station&tab=console&new=1'
	);
	expect( hrefs[ 'kakapo-7901' ] ).toBe(
		'admin.php?page=newspack-nodes-station&tab=console&topology=kakapo-7901'
	);
} );

it( 'asks the fleet board nothing while a row is dragged, and asks again on drop', async () => {
	const container = await rendered( <OverviewTab /> );
	let at = NOW_S;
	jest.spyOn( Core, 'now' ).mockImplementation( () => at );
	const later = async ( seconds ) => {
		at += seconds;
		await act( async () => Core.node( '_router' ).fireCb() );
	};
	await later( 6 );
	const before = asked( 'dump_graph' );
	expect( before ).toBeGreaterThan( 1 );

	const grip = container.querySelector( '.nodes-tm__grip' );
	await act( async () =>
		fireEvent.pointerDown( grip, { pointerId: 1, clientY: 4 } )
	);
	await later( 6 );
	await later( 6 );
	expect( asked( 'dump_graph' ) ).toBe( before );
	expect( asked( 'dump' ) ).toBe( asked( 'dump_graph' ) );

	await act( async () =>
		fireEvent.pointerUp( grip, { pointerId: 1, clientY: 4 } )
	);
	await later( 6 );
	expect( asked( 'dump_graph' ) ).toBeGreaterThan( before );
} );

it( 'shows the fleet tiles once the polls answer, before any probe record arrives', async () => {
	const { container } = render( <OverviewTab /> );
	for ( let tick = 0; tick < 4; tick++ ) {
		await act( async () => {
			Core.node( '_router' )?.fireCb();
		} );
	}
	expect(
		[ ...container.querySelectorAll( '.newspack-nodes-stat-label' ) ].map(
			( label ) => label.textContent
		)
	).toContain( 'Topologies' );
	expect(
		container.querySelector( '.nodes-card--topologies .nodes-card__value' )
			.textContent
	).toBe( '2 · 1 active' );
} );

it( 'joins the fleet board once per answer, however many blocks read it', async () => {
	const board = require( '../../event-dashboards/hooks/useTopologyManager' );
	const joins = jest.spyOn( board, 'boardOf' );
	await rendered( <OverviewTab /> );
	expect( joins.mock.calls.length ).toBeGreaterThan( 0 );
	const pairs = new Set();
	for ( const [ worker, topology ] of joins.mock.calls ) {
		const seen = [ ...pairs ].some(
			( [ w, t ] ) => w === worker && t === topology
		);
		expect( seen ).toBe( false );
		pairs.add( [ worker, topology ] );
	}
} );
