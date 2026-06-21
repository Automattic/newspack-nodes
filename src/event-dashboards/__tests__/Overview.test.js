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

const { useTopologyManager } = require( '../hooks/useTopologyManager' );
const { useNodeState } = require( '../../runtime/react' );

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
} );
afterEach( () => {
	useTopologyManager.mockReset();
	useNodeState.mockReset();
} );

describe( 'Overview fleet board', () => {
	it( 'fleet strip summarizes topology + active counts and partitions-up', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [
						worker( { partition: 0 } ),
						worker( { partition: 1 } ),
					] ),
					active( 'beta', 'stalled', [
						worker( { partition: 0, status: 'dead' } ),
					] ),
					{ name: 'gamma', source: 'stock', active: false },
				],
			} )
		);
		const { container } = render( <Overview /> );
		const fleet = container.querySelector( '.nodes-overview__fleet' );
		expect( fleet.textContent ).toMatch( /3 topologies/ );
		expect( fleet.textContent ).toMatch( /2 active/ );
		// 2 active partitions running (alpha p0+p1), 1 dead (beta) → 2/3 up.
		expect( fleet.textContent ).toMatch( /2\s*\/\s*3/ );
	} );

	it( 'shows a worst-health pill: stalled outranks behind outranks ok', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'a', 'behind', [ worker( { behind: 4096 } ) ] ),
					active( 'b', 'stalled', [ worker( { status: 'dead' } ) ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		const pill = container.querySelector( '.nodes-overview__fleet-health' );
		expect( pill.className ).toContain(
			'nodes-overview__fleet-health--stalled'
		);
		expect( pill.textContent ).toMatch( /1 stalled/ );
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
		// Edit deep-link survives.
		expect(
			row.querySelector( '.nodes-overview__edit' ).getAttribute( 'href' )
		).toContain( 'edit=1' );
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
		expect(
			stopped
				.querySelector( '.nodes-overview__edit' )
				.getAttribute( 'href' )
		).toContain( 'edit=1' );
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

	it( 'offers a New Topology deep-link', () => {
		useTopologyManager.mockReturnValue( hookValue() );
		const { container } = render( <Overview /> );
		expect(
			container
				.querySelector( '.nodes-overview__new' )
				.getAttribute( 'href' )
		).toContain( 'new=1' );
	} );
} );
