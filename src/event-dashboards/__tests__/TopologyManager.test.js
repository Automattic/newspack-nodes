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

/* global globalThis */
import { render, fireEvent, act } from '@testing-library/react';
import TopologyManager from '../TopologyManager';

jest.mock( '../hooks/useTopologyManager', () => ( {
	__esModule: true,
	useTopologyManager: jest.fn(),
} ) );
// The probe stream is its own suite; here the link is a no-op and the cards'
// 24h totals come from useNodeState (mocked undefined by default).
jest.mock( '../hooks/useTopicProbeStream', () => ( {
	useTopicProbeStream: jest.fn(),
} ) );
jest.mock( '../../runtime/react', () => ( {
	...jest.requireActual( '../../runtime/react' ),
	useNodeState: jest.fn(),
} ) );
// SummaryCards has its OWN suite (the fleet-card math + the "+ New Topology"
// link). Here it's a prop-capturing stub so the tab only proves it wired the
// right inputs.
jest.mock( '../SummaryCards', () => {
	const el = require( '@wordpress/element' );
	return ( props ) => {
		( globalThis.__summaryCards ||= [] ).push( props );
		return el.createElement( 'div', { className: 'nodes-cards-stub' } );
	};
} );
// TopologyControls has its OWN suite (the toggle/restart/edit DOM + the
// click→activate/deactivate/restart behavior + onError on rejection). Here it's
// a prop-capturing stub so the tab only proves it wired the right handlers +
// active flag + editHref per topology.
jest.mock( '../TopologyControls', () => {
	const el = require( '@wordpress/element' );
	return ( props ) => {
		( globalThis.__topologyControls ||= [] ).push( props );
		return el.createElement( 'span', { className: 'nodes-ctl-stub' } );
	};
} );

const { useTopologyManager } = require( '../hooks/useTopologyManager' );
const { useNodeState } = require( '../../runtime/react' );

// Find the captured TopologyControls props for a topology by name.
function controlFor( name ) {
	return globalThis.__topologyControls.find( ( c ) => c.name === name );
}

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
		readRate: 0,
		writeRate: 0,
		logPartitions: 0,
		activate: jest.fn( () => Promise.resolve() ),
		deactivate: jest.fn( () => Promise.resolve() ),
		restart: jest.fn( () => Promise.resolve() ),
		connected: true,
		...overrides,
	};
}

beforeEach( () => {
	useNodeState.mockReturnValue( undefined );
	globalThis.__summaryCards = [];
	globalThis.__topologyControls = [];
} );
afterEach( () => {
	useTopologyManager.mockReset();
	useNodeState.mockReset();
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

test( 'only the active topology links its name to live mode; the inactive one is plain text but keeps Edit', () => {
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

	const [ alphaName, betaName ] = [
		...container.querySelectorAll( '.nodes-tm__name' ),
	];
	// Active → a live-mode link (topology= without edit=).
	expect( alphaName.tagName ).toBe( 'A' );
	expect( alphaName.getAttribute( 'href' ) ).toContain( 'topology=alpha' );
	expect( alphaName.getAttribute( 'href' ) ).not.toContain( 'edit=1' );
	// Inactive → plain text, no live-mode link.
	expect( betaName.tagName ).not.toBe( 'A' );
	expect( betaName.getAttribute( 'href' ) ).toBeNull();
	// Both keep their Edit deep-link — now carried on TopologyControls (own suite).
	expect( controlFor( 'alpha' ).editHref ).toContain( 'edit=1' );
	expect( controlFor( 'beta' ).editHref ).toContain( 'edit=1' );
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

test( 'an inactive topology hands its controls active=false + the hook mutations', () => {
	// The toggle DOM and its click→activate behavior live in TopologyControls'
	// own suite; here the tab proves it passed the inactive flag and the hook's
	// activate/deactivate spies down.
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

	render( <TopologyManager /> );
	const ctl = controlFor( 'beta' );
	expect( ctl.active ).toBe( false );
	expect( ctl.onActivate ).toBe( value.activate );
	expect( ctl.onDeactivate ).toBe( value.deactivate );
} );

test( 'an active topology hands its controls active=true + the hook mutations', () => {
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

	render( <TopologyManager /> );
	const ctl = controlFor( 'alpha' );
	expect( ctl.active ).toBe( true );
	expect( ctl.onDeactivate ).toBe( value.deactivate );
	expect( ctl.onRestart ).toBe( value.restart );
} );

test( 'an active topology name links to the console for that topology', () => {
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

test( "an active topology's controls carry the hook restart spy", () => {
	// The restart button (active-only) and its click→restart behavior live in
	// TopologyControls' own suite; here the tab proves it threaded the spy.
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

	render( <TopologyManager /> );
	expect( controlFor( 'alpha' ).onRestart ).toBe( value.restart );
} );

test( 'a rejected mutation reported via onError raises an alert without crashing', () => {
	// TopologyControls owns the click→mutation→catch→onError path (own suite);
	// the tab owns onError→AlertModal. Drive the tab's half by invoking the
	// captured onError directly.
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
	const { onError } = controlFor( 'beta' );
	expect( () =>
		act( () => onError( { name: 'beta', message: 'boom' } ) )
	).not.toThrow();
	expect( container.querySelector( '.nodes-tm__alert' ) ).toBeTruthy();
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

test( 'the alert modal names the topology and shows the rejection reason via onError', () => {
	// TopologyControls catches the rejection and calls onError({name,message});
	// the tab renders that into the modal. Drive the tab's half directly.
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

	const { container, getByText } = render( <TopologyManager /> );
	act( () =>
		controlFor( 'beta' ).onError( {
			name: 'beta',
			message: 'conflict: beta and alpha both write requests.p0',
		} )
	);

	expect( container.querySelector( '.nodes-tm__alert' ) ).toBeTruthy();
	expect( getByText( /both write requests\.p0/ ) ).toBeTruthy();
	// The topology name is named in the modal title so an operator knows which failed.
	expect(
		container.querySelector( '.nodes-tm__alert-title' ).textContent
	).toMatch( /beta/ );
} );

test( 'the alert modal closes via its OK button', () => {
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

	const { container, getByRole } = render( <TopologyManager /> );
	act( () =>
		controlFor( 'beta' ).onError( { name: 'beta', message: 'boom' } )
	);
	expect( container.querySelector( '.nodes-tm__alert' ) ).toBeTruthy();
	fireEvent.click( getByRole( 'button', { name: 'OK' } ) );
	expect( container.querySelector( '.nodes-tm__alert' ) ).toBeFalsy();
} );

test( 'a rejected restart/deactivate is surfaced in the modal via onError', () => {
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
	} );
	useTopologyManager.mockReturnValue( value );

	const { container, getByText } = render( <TopologyManager /> );
	act( () =>
		controlFor( 'alpha' ).onError( {
			name: 'alpha',
			message: 'drain failed: workers busy',
		} )
	);

	expect( container.querySelector( '.nodes-tm__alert' ) ).toBeTruthy();
	expect( getByText( /drain failed: workers busy/ ) ).toBeTruthy();
} );

it( 'hands TopologyControls a per-topology Edit deep-link in edit mode', () => {
	// The Edit <a> itself lives in TopologyControls (own suite); the tab proves
	// it passed the correct console edit deep-link.
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [ { name: 'alpha', source: 'user', active: false } ],
		} )
	);
	render( <TopologyManager /> );
	const href = controlFor( 'alpha' ).editHref;
	expect( href ).toContain( 'tab=console' );
	expect( href ).toContain( 'topology=alpha' );
	expect( href ).toContain( 'edit=1' );
} );

it( 'hands SummaryCards a New Topology deep-link to a blank console editor', () => {
	// The "+ New Topology" link itself lives in SummaryCards (own suite); the
	// tab proves it passed the new-editor deep-link.
	useTopologyManager.mockReturnValue( hookValue( { topologies: [] } ) );
	render( <TopologyManager /> );
	const href = globalThis.__summaryCards[ 0 ].newTopologyHref;
	expect( href ).toContain( 'tab=console' );
	// Distinct `new=1` signal (not edit=1) so the console's topology→URL sync
	// can't make it look like editing the default topology.
	expect( href ).toContain( 'new=1' );
	expect( href ).not.toContain( 'topology=' );
} );
