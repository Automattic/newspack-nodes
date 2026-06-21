/* global globalThis */
/**
 * Overview — the hub's at-a-glance fleet-health board (the first paint). A live
 * "is everything OK right now?" glance over useTopologyManager: a fleet strip
 * (counts + partitions-up + a worst-health pill), the supervisor card, one row
 * per ACTIVE topology (per-partition worker pills + consumer lag + uptime,
 * problems sorted first), and a de-emphasized group of stopped topologies. The
 * hook's data contract is exercised by its own suite; here it's mocked.
 */

import { render } from '@testing-library/react';
import Overview from '../Overview';

jest.mock( '../hooks/useTopologyManager', () => ( {
	useTopologyManager: jest.fn(),
} ) );
// The probe stream is its own suite; here the link is a no-op and the view model
// is fed directly via useNodeState.
jest.mock( '../hooks/useTopicProbeStream', () => ( {
	useTopicProbeStream: jest.fn(),
} ) );
jest.mock( '../../runtime/react', () => ( {
	...jest.requireActual( '../../runtime/react' ),
	useNodeState: jest.fn(),
} ) );
// TopicsChart is d3-driven (its own suite); here it's a prop-capturing stub so
// the Overview suite stays free of d3 and can assert what each panel was fed.
jest.mock( '../TopicsChart', () => {
	const el = require( '@wordpress/element' );
	return {
		TopicsChart: ( props ) => {
			( globalThis.__topicsPanels ||= [] ).push( props );
			return el.createElement(
				'div',
				{ className: 'nodes-topics' },
				el.createElement(
					'div',
					{ className: 'nodes-topics__title' },
					props.title
				)
			);
		},
	};
} );
// SummaryCards has its OWN suite (the fleet-card math + the "+ New Topology"
// link live there). Here it's a prop-capturing stub: the tab is only on the hook
// for handing it the right inputs, so assert against the captured props.
jest.mock( '../SummaryCards', () => {
	const el = require( '@wordpress/element' );
	return ( props ) => {
		( globalThis.__summaryCards ||= [] ).push( props );
		return el.createElement( 'div', { className: 'nodes-cards-stub' } );
	};
} );
// TopologyControls has its OWN suite (the toggle/restart/edit DOM + the
// click→activate/deactivate/restart behavior + onError on rejection live there).
// Here it's a prop-capturing stub so the tab only proves it wired the right
// handlers + active flag + editHref per topology.
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

// A worker descriptor (server `dump_graph` shape, passed through verbatim).
function worker( overrides = {} ) {
	return {
		partition: 0,
		status: 'running',
		started_at: 1000,
		heartbeat_age: 2,
		behind: 0,
		restart_pending: false,
		...overrides,
	};
}

function active( name, health, workers, source = 'user' ) {
	return {
		name,
		source,
		active: true,
		health,
		status: { workers },
	};
}

function hookValue( overrides = {} ) {
	return {
		topologies: [],
		supervisor: null,
		currentTime: 5000,
		readRate: 0,
		writeRate: 0,
		logPartitions: 0,
		activate: jest.fn(),
		deactivate: jest.fn(),
		restart: jest.fn(),
		connected: true,
		...overrides,
	};
}

beforeEach( () => {
	useNodeState.mockReturnValue( undefined );
	globalThis.__topicsPanels = [];
	globalThis.__summaryCards = [];
	globalThis.__topologyControls = [];
} );
afterEach( () => {
	useTopologyManager.mockReset();
	useNodeState.mockReset();
} );

describe( 'Overview fleet board', () => {
	it( 'feeds SummaryCards the fleet topologies and the hook R/W rates + partition count', () => {
		// The fleet counts/partitions-up/health now live in SummaryCards (own
		// suite); the tab's job is to hand it the right inputs.
		const topologies = [
			active( 'alpha', 'ok', [
				worker( { partition: 0 } ),
				worker( { partition: 1 } ),
			] ),
			active( 'beta', 'stalled', [
				worker( { partition: 0, status: 'dead' } ),
			] ),
			{ name: 'gamma', source: 'stock', active: false },
		];
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies,
				readRate: 4096,
				writeRate: 8192,
				logPartitions: 3,
			} )
		);
		render( <Overview /> );
		const cards = globalThis.__summaryCards[ 0 ];
		expect( cards.topologies ).toBe( topologies );
		expect( cards.readRate ).toBe( 4096 );
		expect( cards.writeRate ).toBe( 8192 );
		expect( cards.logPartitions ).toBe( 3 );
	} );

	it( 'an active row shows partition pills, lag, and a live-mode name link', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'behind', [
						worker( { partition: 0, behind: 4096 } ),
					] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		const row = container.querySelector( '.nodes-overview__row' );
		// Name links to live mode.
		const name = row.querySelector( '.nodes-overview__name' );
		expect( name.tagName ).toBe( 'A' );
		expect( name.getAttribute( 'href' ) ).toContain( 'topology=alpha' );
		expect( name.getAttribute( 'href' ) ).not.toContain( 'edit=1' );
		// A partition pill is present.
		expect( row.querySelector( '.nodes-overview__part' ) ).not.toBeNull();
		// Consumer lag is surfaced (the critique's headline metric).
		expect(
			row.querySelector( '.nodes-overview__lag' ).textContent
		).toMatch( /lag/i );
		// The active-topology controls are wired through TopologyControls (own
		// suite): active flag set, hook handlers passed, Edit deep-link survives.
		const ctl = controlFor( 'alpha' );
		expect( ctl.active ).toBe( true );
		expect( ctl.editHref ).toContain( 'edit=1' );
	} );

	it( 'sorts problem topologies above healthy ones', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'aaa-ok', 'ok', [ worker() ] ),
					active( 'zzz-stalled', 'stalled', [
						worker( { status: 'dead' } ),
					] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		const names = [
			...container.querySelectorAll(
				'.nodes-overview__row .nodes-overview__name'
			),
		].map( ( n ) => n.textContent );
		// 'zzz-stalled' floats above 'aaa-ok' despite sorting last alphabetically.
		expect( names ).toEqual( [ 'zzz-stalled', 'aaa-ok' ] );
	} );

	it( 'puts stopped topologies in a de-emphasized group: plain name, Edit only, no live link', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{ name: 'beta', source: 'stock', active: false },
				],
			} )
		);
		const { container } = render( <Overview /> );
		// Not rendered as an active row.
		expect( container.querySelector( '.nodes-overview__row' ) ).toBeNull();
		const stopped = container.querySelector( '.nodes-overview__stopped' );
		expect( stopped ).not.toBeNull();
		const name = stopped.querySelector( '.nodes-overview__name' );
		expect( name.textContent ).toBe( 'beta' );
		expect( name.tagName ).not.toBe( 'A' );
		// Edit deep-link now rides on TopologyControls (active=false), own suite.
		const ctl = controlFor( 'beta' );
		expect( ctl.active ).toBe( false );
		expect( ctl.editHref ).toContain( 'edit=1' );
	} );

	it( 'renders the three Topics panels (message rate, byte rate, backlog)', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		const { container } = render( <Overview /> );
		const titles = [
			...container.querySelectorAll( '.nodes-topics__title' ),
		].map( ( n ) => n.textContent );
		expect( titles ).toEqual( [
			'Topics Message Rate',
			'Topics Byte Rate',
			'Topics Backlog',
		] );
	} );

	it( 'feeds each panel its per-topic 24h series rolled up from the probe view', () => {
		useNodeState.mockReturnValue( {
			consumers: {
				'firehose.p0': {
					source: 'firehose.p0',
					series: [
						{ ts: 100, msgRate: 1, byteRate: 4096, backlog: 0 },
						{ ts: 115, msgRate: 2, byteRate: 8192, backlog: 0 },
					],
				},
			},
		} );
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		render( <Overview /> );
		const panel = ( title ) =>
			globalThis.__topicsPanels.find( ( p ) => p.title === title );
		// The Byte Rate panel gets firehose.p0's byte-rate series (2 points).
		const byteRate = panel( 'Topics Byte Rate' ).series[ 'firehose.p0' ];
		expect( byteRate.points.map( ( p ) => p.value ) ).toEqual( [
			4096, 8192,
		] );
		// The Backlog panel groups the same topic, value 0 (caught up).
		expect(
			panel( 'Topics Backlog' ).series[ 'firehose.p0' ].points.map(
				( p ) => p.value
			)
		).toEqual( [ 0, 0 ] );
	} );

	it( 'offers a New Topology deep-link via SummaryCards', () => {
		useTopologyManager.mockReturnValue( hookValue() );
		render( <Overview /> );
		// The "+ New Topology" link itself is SummaryCards' (own suite); the tab
		// only proves it passed the new-editor deep-link down.
		expect( globalThis.__summaryCards[ 0 ].newTopologyHref ).toContain(
			'new=1'
		);
	} );
} );
