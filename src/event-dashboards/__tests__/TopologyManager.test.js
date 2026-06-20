/**
 * TopologyManager UI-surface tests — the thin view over the useTopologyManager
 * hook. The hook's data contract (poll, merge, mutations) is exercised by its
 * own suite; here we mock it to hand back a fixed `topologies` list plus spy
 * mutations, and assert the rendered DOM:
 *  - both topologies render with name + source badge;
 *  - the active one renders its TopologySection live subtree;
 *  - the inactive one renders a "Stopped" row;
 *  - clicking the inactive toggle calls activate, the active toggle calls
 *    deactivate, and the active restart button calls restart.
 */

import { render, fireEvent, waitFor } from '@testing-library/react';
import TopologyManager from '../TopologyManager';

jest.mock( '../hooks/useTopologyManager', () => ( {
	__esModule: true,
	useTopologyManager: jest.fn(),
} ) );

const { useTopologyManager } = require( '../hooks/useTopologyManager' );

// A live status section for the active topology. The shape mirrors the enriched
// worker-status MODEL slices the hook now attaches per active topology (graph +
// workers + the same rate/segment/time maps WorkerStatus passes to
// TopologySection), so the manager tree renders with the same richness rather
// than a degraded `{ graph, workers }` reduction.
//
// The worker's `handler` MATCHES the graph's logic-node vertex name (`producer`)
// so `workersByHandler.get('producer')` is non-empty and a real node row renders
// — exercising the `byteRates[ key ]` read in TreeEntity's NodeRow that
// white-screened the tab whenever rates weren't threaded through.
function activeStatus() {
	return {
		graph: {
			nodes: [ { name: 'producer', kind: 'logic' } ],
			edges: [],
		},
		workers: [
			{
				type: 'alpha',
				handler: 'producer',
				partition: 0,
				source: '',
				status: 'running',
				started_at: 1000,
			},
		],
		byteRates: { 'producer-0-': 2048 },
		writeRates: {},
		segmentSize: 64 * 1024 * 1024,
		currentTime: 2000,
		prevSegments: {},
		removingSegments: {},
	};
}

function hookValue( overrides = {} ) {
	return {
		topologies: [],
		supervisor: null,
		currentTime: 2000,
		activate: jest.fn( () => Promise.resolve() ),
		deactivate: jest.fn( () => Promise.resolve() ),
		restart: jest.fn( () => Promise.resolve() ),
		connected: true,
		...overrides,
	};
}

afterEach( () => {
	useTopologyManager.mockReset();
} );

// A supervisor descriptor for the supervisor-card tests.
function supervisorModel() {
	return {
		status: 'running',
		started_at: 1000,
		heartbeat_age: 2,
		restart_pending: false,
	};
}

// An active status whose logs catalog carries a log with a segment, so the
// 3-arg buildTopologySections call produces a segment bar in the rendered tree.
// The graph carries a `partition`-kind node whose `writes` vertex matches the
// catalog entry name, so makeLog resolves its segments.
function statusWithSegments() {
	return {
		graph: {
			nodes: [ { name: 'sink', kind: 'partition', writes: 'a-log' } ],
			edges: [],
		},
		workers: [],
		logs: [
			{
				name: 'a-log',
				segment_size: 64 * 1024 * 1024,
				partitions: [
					{
						partition: 0,
						segments: [ { id: 0, size: 1024, mtime: 1000 } ],
						total_size: 1024,
					},
				],
			},
		],
		byteRates: {},
		writeRates: {},
		segmentSize: 64 * 1024 * 1024,
		currentTime: 2000,
		prevSegments: {},
		removingSegments: {},
	};
}

test( 'renders the supervisor card when supervisor is present', () => {
	useTopologyManager.mockReturnValue(
		hookValue( { supervisor: supervisorModel() } )
	);

	const { container } = render( <TopologyManager /> );
	expect( container.querySelector( '.supervisor-section' ) ).toBeTruthy();
} );

test( 'does not render the supervisor card when supervisor is null', () => {
	useTopologyManager.mockReturnValue( hookValue( { supervisor: null } ) );

	const { container } = render( <TopologyManager /> );
	expect( container.querySelector( '.supervisor-section' ) ).toBeFalsy();
} );

test( 'renders a non-NaN supervisor uptime (currentTime threaded to the card)', () => {
	// supervisor started_at 1000, currentTime 2000 → 1000s uptime → "16m".
	useTopologyManager.mockReturnValue(
		hookValue( { supervisor: supervisorModel(), currentTime: 2000 } )
	);

	const { container } = render( <TopologyManager /> );
	const age = container.querySelector( '.supervisor-age' );
	expect( age ).toBeTruthy();
	expect( age.textContent ).not.toContain( 'NaN' );
	expect( age.textContent ).toMatch( /^\d+[smh]/ );
	expect( age.textContent ).toBe( '16m' );
} );

test( 'clicking the supervisor restart button calls restart("supervisor")', () => {
	const value = hookValue( { supervisor: supervisorModel() } );
	useTopologyManager.mockReturnValue( value );

	const { container } = render( <TopologyManager /> );
	// The supervisor restart control uses the same class as the per-topology
	// restart buttons so the two match visually.
	const btn = container.querySelector(
		'.supervisor-section .nodes-tm__restart'
	);
	expect( btn ).toBeTruthy();
	fireEvent.click( btn );
	expect( value.restart ).toHaveBeenCalledWith( 'supervisor' );
} );

test( "an active topology's logs catalog renders segment bars (3rd buildTopologySections arg flows)", () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 1,
					status: statusWithSegments(),
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	const section = container.querySelector( '.topology-section' );
	expect( section ).toBeTruthy();
	expect( section.querySelector( '.worker-segment-h' ) ).toBeTruthy();
	expect( section.querySelector( '.segment-bar-h' ) ).toBeTruthy();
} );

test( 'renders every topology with its name and source badge', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 2,
					status: activeStatus(),
				},
				{
					name: 'beta',
					source: 'user',
					active: false,
					num_partitions: 1,
					status: null,
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );

	const names = [ ...container.querySelectorAll( '.nodes-tm__name' ) ].map(
		( n ) => n.textContent
	);
	expect( names ).toEqual( [ 'alpha', 'beta' ] );
	expect( container.querySelector( '.nodes-tm__badge--stock' ) ).toBeTruthy();
	expect( container.querySelector( '.nodes-tm__badge--user' ) ).toBeTruthy();
} );

test( 'floats active topologies above inactive ones, alpha within each group', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: false,
					num_partitions: 1,
					status: null,
				},
				{
					name: 'zeta',
					source: 'stock',
					active: true,
					num_partitions: 1,
					status: activeStatus(),
				},
				{
					name: 'mid',
					source: 'stock',
					active: false,
					num_partitions: 1,
					status: null,
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	const names = [ ...container.querySelectorAll( '.nodes-tm__name' ) ].map(
		( n ) => n.textContent
	);
	// Active 'zeta' first despite sorting last alphabetically; inactive alpha-sorted after.
	expect( names ).toEqual( [ 'zeta', 'alpha', 'mid' ] );
} );

test( 'renders the user-shadows-stock badge for source "both"', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'gamma',
					source: 'both',
					active: false,
					num_partitions: 1,
					status: null,
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	expect( container.querySelector( '.nodes-tm__badge--both' ) ).toBeTruthy();
} );

test( 'active topology renders its live TopologySection subtree; inactive renders Stopped', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 2,
					status: activeStatus(),
				},
				{
					name: 'beta',
					source: 'user',
					active: false,
					num_partitions: 1,
					status: null,
				},
			],
		} )
	);

	const { container, getByText } = render( <TopologyManager /> );

	// The active topology's TopologySection renders the .tsl tree.
	expect( container.querySelector( '.topology-section' ) ).toBeTruthy();
	// The inactive topology renders the Stopped placeholder.
	expect( container.querySelector( '.nodes-tm__stopped' ) ).toBeTruthy();
	expect( getByText( 'Stopped' ) ).toBeTruthy();
} );

test( 'an active topology without a graph status falls back to Stopped', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 1,
					status: null,
				},
			],
		} )
	);

	const { getByText } = render( <TopologyManager /> );
	expect( getByText( 'Stopped' ) ).toBeTruthy();
} );

test( 'active topology renders a node row with its read rate (not a crash, not 0 B/s)', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 1,
					status: activeStatus(),
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );

	// A real node row rendered (the worker's handler matched a graph vertex).
	const rate = container.querySelector( '.connector-rate' );
	expect( rate ).toBeTruthy();
	// And it shows the model's actual rate, not a degraded 0 B/s placeholder.
	expect( rate.textContent ).toContain( '2' );
	expect( rate.textContent ).not.toContain( '0 B/s' );
} );

test( 'folding an active topology section hides and restores its segment rows', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 1,
					status: statusWithSegments(),
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	const caret = container.querySelector( '.caret' );
	expect( container.querySelector( '.worker-segment-h' ) ).toBeTruthy();
	fireEvent.click( caret );
	expect( container.querySelector( '.worker-segment-h' ) ).toBeFalsy();
	fireEvent.click( caret );
	expect( container.querySelector( '.worker-segment-h' ) ).toBeTruthy();
} );

test( 'clicking the inactive toggle calls activate(name)', () => {
	const value = hookValue( {
		topologies: [
			{
				name: 'beta',
				source: 'user',
				active: false,
				num_partitions: 1,
				status: null,
			},
		],
	} );
	useTopologyManager.mockReturnValue( value );

	const { container } = render( <TopologyManager /> );
	const toggle = container.querySelector( '.nodes-tm__toggle' );
	expect( toggle.getAttribute( 'aria-checked' ) ).toBe( 'false' );
	fireEvent.click( toggle );

	expect( value.activate ).toHaveBeenCalledWith( 'beta' );
	expect( value.deactivate ).not.toHaveBeenCalled();
} );

test( 'clicking the active toggle calls deactivate(name)', () => {
	const value = hookValue( {
		topologies: [
			{
				name: 'alpha',
				source: 'stock',
				active: true,
				num_partitions: 2,
				status: activeStatus(),
			},
		],
	} );
	useTopologyManager.mockReturnValue( value );

	const { container } = render( <TopologyManager /> );
	const toggle = container.querySelector( '.nodes-tm__toggle.is-on' );
	expect( toggle.getAttribute( 'aria-checked' ) ).toBe( 'true' );
	fireEvent.click( toggle );

	expect( value.deactivate ).toHaveBeenCalledWith( 'alpha' );
	expect( value.activate ).not.toHaveBeenCalled();
} );

test( 'the topology name links to the console for that topology', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: false,
					num_partitions: 1,
					status: null,
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	const link = container.querySelector( 'a.nodes-tm__name' );
	expect( link ).toBeTruthy();
	expect( link.getAttribute( 'href' ) ).toBe(
		'admin.php?page=newspack-nodes-hub&tab=console&topology=alpha'
	);
	expect( link.textContent ).toBe( 'alpha' );
} );

test( 'the manager heading carries the per-partition pills moved from the section header', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 2,
					status: {
						...activeStatus(),
						workers: [
							{
								type: 'alpha',
								handler: 'producer',
								partition: 0,
								source: '',
								status: 'running',
								started_at: 1000,
								heartbeat_age: 2,
							},
							{
								type: 'alpha',
								handler: 'producer',
								partition: 1,
								source: '',
								status: 'running',
								started_at: 1000,
								heartbeat_age: 40,
							},
						],
					},
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	const heading = container.querySelector( '.nodes-tm__heading' );
	// Two per-partition pills moved up from the old section header.
	expect( heading.querySelectorAll( '.topology-partition' ) ).toHaveLength(
		2
	);
	// The stale-heartbeat marker rendered for P1 (heartbeat_age 40 > 30).
	expect(
		heading.querySelector( '.connector-heartbeat.stale' )
	).toBeTruthy();
	// ALL RUN moved up into the heading.
	expect( heading.textContent ).toMatch( /ALL RUN/ );
} );

test( 'the manager heading shows ALL DEAD when every partition is dead', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 1,
					status: {
						...activeStatus(),
						workers: [
							{
								type: 'alpha',
								handler: 'producer',
								partition: 0,
								source: '',
								status: 'dead',
								started_at: 1000,
							},
						],
					},
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	const heading = container.querySelector( '.nodes-tm__heading' );
	expect( heading.textContent ).toMatch( /ALL DEAD/ );
} );

test( 'clicking the restart button on an active topology calls restart(name)', () => {
	const value = hookValue( {
		topologies: [
			{
				name: 'alpha',
				source: 'stock',
				active: true,
				num_partitions: 2,
				status: activeStatus(),
			},
		],
	} );
	useTopologyManager.mockReturnValue( value );

	const { container } = render( <TopologyManager /> );
	const restartBtn = container.querySelector( '.nodes-tm__restart' );
	expect( restartBtn ).toBeTruthy();
	fireEvent.click( restartBtn );

	expect( value.restart ).toHaveBeenCalledWith( 'alpha' );
} );

test( 'a rejected mutation does not crash the render', async () => {
	const value = hookValue( {
		activate: jest.fn( () => Promise.reject( new Error( 'boom' ) ) ),
		topologies: [
			{
				name: 'beta',
				source: 'user',
				active: false,
				num_partitions: 1,
				status: null,
			},
		],
	} );
	useTopologyManager.mockReturnValue( value );

	const { container } = render( <TopologyManager /> );
	const toggle = container.querySelector( '.nodes-tm__toggle' );
	expect( () => fireEvent.click( toggle ) ).not.toThrow();
	expect( value.activate ).toHaveBeenCalledWith( 'beta' );
	// The rejection resolves asynchronously into an alert; await it so the
	// catch→setAlert update flushes inside act() and we confirm the render
	// survived rather than crashed.
	await waitFor( () =>
		expect( container.querySelector( '.nodes-tm__alert' ) ).toBeTruthy()
	);
} );

test( 'shows the rolled-up health indicator on the topology heading', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 2,
					status: activeStatus(),
					health: 'stalled',
					partitions: [
						{ partition: 0, stalled: false },
						{ partition: 1, stalled: true },
					],
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	const health = container.querySelector( '.nodes-tm__health--stalled' );
	expect( health ).toBeTruthy();
} );

test( 'shows a connection banner when not connected', () => {
	useTopologyManager.mockReturnValue(
		hookValue( { connected: false, topologies: [] } )
	);

	const { container } = render( <TopologyManager /> );
	expect(
		container.querySelector( '.newspack-nodes-connection-banner' )
	).toBeTruthy();
} );

test( 'the heading drops the redundant "N partitions" subtitle', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 2,
					status: activeStatus(),
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	expect( container.querySelector( '.nodes-tm__sub' ) ).toBeFalsy();
} );

test( 'the partition pills sit left of the source badge so they scan against the tree', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 1,
					status: activeStatus(),
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	const heading = container.querySelector( '.nodes-tm__heading' );
	const pill = heading.querySelector( '.topology-partition' );
	const badge = heading.querySelector( '.nodes-tm__badge' );
	expect( pill ).toBeTruthy();
	expect( badge ).toBeTruthy();
	// DOCUMENT_POSITION_FOLLOWING ⇒ badge comes AFTER the pill in DOM order.
	expect(
		pill.compareDocumentPosition( badge ) &
			window.Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
} );

test( 'a rejected activate surfaces the reason in an alert modal', async () => {
	const value = hookValue( {
		topologies: [
			{
				name: 'beta',
				source: 'user',
				active: false,
				num_partitions: 1,
				status: null,
			},
		],
		activate: jest.fn( () =>
			Promise.reject(
				new Error( 'conflict: beta and alpha both write requests.p0' )
			)
		),
	} );
	useTopologyManager.mockReturnValue( value );

	const { container, getByText } = render( <TopologyManager /> );
	fireEvent.click( container.querySelector( '.nodes-tm__toggle' ) );

	await waitFor( () =>
		expect( container.querySelector( '.nodes-tm__alert' ) ).toBeTruthy()
	);
	expect( getByText( /both write requests\.p0/ ) ).toBeTruthy();
	// The topology name is named in the modal title so an operator knows which failed.
	expect(
		container.querySelector( '.nodes-tm__alert-title' ).textContent
	).toMatch( /beta/ );
} );

test( 'the alert modal closes via its OK button', async () => {
	const value = hookValue( {
		topologies: [
			{
				name: 'beta',
				source: 'user',
				active: false,
				num_partitions: 1,
				status: null,
			},
		],
		activate: jest.fn( () => Promise.reject( new Error( 'boom' ) ) ),
	} );
	useTopologyManager.mockReturnValue( value );

	const { container, getByRole } = render( <TopologyManager /> );
	fireEvent.click( container.querySelector( '.nodes-tm__toggle' ) );
	await waitFor( () =>
		expect( container.querySelector( '.nodes-tm__alert' ) ).toBeTruthy()
	);
	fireEvent.click( getByRole( 'button', { name: 'OK' } ) );
	expect( container.querySelector( '.nodes-tm__alert' ) ).toBeFalsy();
} );

test( 'a rejected restart/deactivate is swallowed from the render but surfaced in the modal', async () => {
	const value = hookValue( {
		topologies: [
			{
				name: 'alpha',
				source: 'stock',
				active: true,
				num_partitions: 1,
				status: activeStatus(),
			},
		],
		deactivate: jest.fn( () =>
			Promise.reject( new Error( 'drain failed: workers busy' ) )
		),
	} );
	useTopologyManager.mockReturnValue( value );

	const { container, getByText } = render( <TopologyManager /> );
	fireEvent.click( container.querySelector( '.nodes-tm__toggle.is-on' ) );

	await waitFor( () =>
		expect( container.querySelector( '.nodes-tm__alert' ) ).toBeTruthy()
	);
	expect( getByText( /drain failed: workers busy/ ) ).toBeTruthy();
} );

it( 'renders a per-topology Edit link that deep-links to the console in edit mode', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [ { name: 'alpha', source: 'user', active: false } ],
		} )
	);
	const { container } = render( <TopologyManager /> );
	const edit = container.querySelector( '.nodes-tm__edit' );
	expect( edit ).not.toBeNull();
	const href = edit.getAttribute( 'href' );
	expect( href ).toContain( 'tab=console' );
	expect( href ).toContain( 'topology=alpha' );
	expect( href ).toContain( 'edit=1' );
} );

it( 'renders a New Topology link that deep-links to a blank console editor', () => {
	useTopologyManager.mockReturnValue( hookValue( { topologies: [] } ) );
	const { container } = render( <TopologyManager /> );
	const create = container.querySelector( '.nodes-tm__new' );
	expect( create ).not.toBeNull();
	const href = create.getAttribute( 'href' );
	expect( href ).toContain( 'tab=console' );
	// Distinct `new=1` signal (not edit=1) so the console's topology→URL sync
	// can't make it look like editing the default topology.
	expect( href ).toContain( 'new=1' );
	expect( href ).not.toContain( 'topology=' );
} );
