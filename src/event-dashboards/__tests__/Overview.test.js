/* global globalThis, Element */
/**
 * Overview — the merged hub board. Every active topology renders as a TopologyRow
 * (folded compact ↔ unfolded detail), in the user's persisted drag order (NOT
 * health), with a de-emphasized stopped group. TopologyRow is stubbed here (its
 * own suite owns the heading/tree DOM); this suite asserts the tab wired the right
 * props (folded flag, handlers, order) and persisted order + fold state.
 */

import { render, fireEvent, act } from '@testing-library/react';
import Overview from '../Overview';

jest.mock( '../hooks/useTopologyManager', () => ( {
	useTopologyManager: jest.fn(),
} ) );
// Persistence is its own suite; here it's mocked so the tab's read-on-init +
// write-through wiring can be asserted without touching real localStorage.
jest.mock( '../overviewPrefs', () => ( {
	readOrder: jest.fn( () => [] ),
	writeOrder: jest.fn(),
	readExpanded: jest.fn( () => new Set() ),
	writeExpanded: jest.fn(),
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
// TopologyRow renders the real d3/TopologySection tree (its OWN suite). Here it's
// a prop-capturing stub so the Overview suite stays free of that tree and can
// assert that the merged tab unfolds the right topology with the right handlers.
// consoleHref is a real (non-component) re-export the tab imports, so keep it.
jest.mock( '../TopologyRow', () => {
	const el = require( '@wordpress/element' );
	const actual = jest.requireActual( '../TopologyRow' );
	return {
		...actual,
		TopologyRow: ( props ) => {
			( globalThis.__topologyRows ||= [] ).push( props );
			return el.createElement( 'div', {
				className: 'nodes-tm__topology-stub',
				'data-name': props.topology.name,
				'data-topology-row': props.topology.name,
				'data-folded': String( !! props.folded ),
				'data-dragging': String( !! props.isDragging ),
			} );
		},
	};
} );

const { useTopologyManager } = require( '../hooks/useTopologyManager' );
const { useNodeState } = require( '../../runtime/react' );
const overviewPrefs = require( '../overviewPrefs' );

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
	overviewPrefs.readOrder.mockReturnValue( [] );
	overviewPrefs.readExpanded.mockReturnValue( new Set() );
	overviewPrefs.writeOrder.mockClear();
	overviewPrefs.writeExpanded.mockClear();
	globalThis.__topicsPanels = [];
	globalThis.__summaryCards = [];
	globalThis.__topologyControls = [];
	globalThis.__topologyRows = [];
} );
afterEach( () => {
	useTopologyManager.mockReset();
	useNodeState.mockReset();
} );

// Active rows are TopologyRow stubs (data-name / data-folded); DOM order = display order.
function rowNames( container ) {
	return [ ...container.querySelectorAll( '.nodes-tm__topology-stub' ) ].map(
		( n ) => n.dataset.name
	);
}
function foldedByName( container ) {
	const out = {};
	for ( const n of container.querySelectorAll(
		'.nodes-tm__topology-stub'
	) ) {
		out[ n.dataset.name ] = n.dataset.folded === 'true';
	}
	return out;
}
// Latest captured props for a topology row (last render wins).
function rowProps( name ) {
	return globalThis.__topologyRows
		.filter( ( r ) => r.topology.name === name )
		.at( -1 );
}

describe( 'Overview fleet board', () => {
	it( 'feeds SummaryCards the fleet topologies and the hook R/W rates + partition count', () => {
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

	it( 'renders each active topology as a TopologyRow wired with the hook handlers + folded flag', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'behind', [ worker( { behind: 4096 } ) ] ),
				],
			} )
		);
		render( <Overview /> );
		const row = rowProps( 'alpha' );
		expect( row.folded ).toBe( true );
		expect( typeof row.onExpand ).toBe( 'function' );
		expect( typeof row.onGripPointerDown ).toBe( 'function' );
		expect( typeof row.onGripPointerMove ).toBe( 'function' );
		expect( typeof row.onGripPointerUp ).toBe( 'function' );
		expect( row.onRestart ).toBe(
			useTopologyManager.mock.results[ 0 ].value.restart
		);
	} );

	it( 'does NOT reorder by health — rows stay alphabetical (nothing stored), badge aside', () => {
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
		// Alphabetical — the stalled one stays put at the bottom (no float-to-top).
		expect( rowNames( container ) ).toEqual( [ 'aaa-ok', 'zzz-stalled' ] );
	} );

	it( 'renders active rows in the persisted stored order, not alphabetical', () => {
		overviewPrefs.readOrder.mockReturnValue( [ 'zzz', 'aaa' ] );
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'aaa', 'ok', [ worker() ] ),
					active( 'mmm', 'ok', [ worker() ] ),
					active( 'zzz', 'ok', [ worker() ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		// Stored 'zzz','aaa' first; the unstored 'mmm' appended at the end.
		expect( rowNames( container ) ).toEqual( [ 'zzz', 'aaa', 'mmm' ] );
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
		// Inactive topologies are never active rows.
		expect(
			container.querySelector( '.nodes-tm__topology-stub' )
		).toBeNull();
		const stopped = container.querySelector( '.nodes-overview__stopped' );
		expect( stopped ).not.toBeNull();
		const name = stopped.querySelector( '.nodes-overview__name' );
		expect( name.textContent ).toBe( 'beta' );
		expect( name.tagName ).not.toBe( 'A' );
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
		expect(
			panel( 'Topics Byte Rate' ).series[ 'firehose.p0' ].points.map(
				( p ) => p.value
			)
		).toEqual( [ 4096, 8192 ] );
		expect(
			panel( 'Topics Backlog' ).series[ 'firehose.p0' ].points.map(
				( p ) => p.value
			)
		).toEqual( [ 0, 0 ] );
	} );

	it( 'offers a New Topology deep-link via SummaryCards', () => {
		useTopologyManager.mockReturnValue( hookValue() );
		render( <Overview /> );
		expect( globalThis.__summaryCards[ 0 ].newTopologyHref ).toContain(
			'new=1'
		);
	} );
} );

describe( 'Overview fold/unfold merge', () => {
	it( 'renders every active topology FOLDED by default', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		expect( foldedByName( container ) ).toEqual( {
			alpha: true,
			beta: true,
		} );
	} );

	it( 'unfolds a topology when its onExpand handler fires', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		act( () => rowProps( 'alpha' ).onExpand( 'alpha' ) );
		expect( foldedByName( container ) ).toEqual( {
			alpha: false,
			beta: true,
		} );
	} );

	it( 'collapsing an unfolded row via onCollapseTopology folds it back', () => {
		overviewPrefs.readExpanded.mockReturnValue( new Set( [ 'alpha' ] ) );
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		const { container } = render( <Overview /> );
		expect( foldedByName( container ) ).toEqual( { alpha: false } );
		act( () => rowProps( 'alpha' ).onCollapseTopology( 'alpha' ) );
		expect( foldedByName( container ) ).toEqual( { alpha: true } );
	} );

	it( 'Unfold all expands every active topology; Fold all collapses them', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { getByText, container } = render( <Overview /> );
		fireEvent.click( getByText( 'Unfold all' ) );
		expect( foldedByName( container ) ).toEqual( {
			alpha: false,
			beta: false,
		} );
		fireEvent.click( getByText( 'Fold all' ) );
		expect( foldedByName( container ) ).toEqual( {
			alpha: true,
			beta: true,
		} );
	} );

	it( 'shows the fold-all toolbar only when there is at least one active topology', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{ name: 'beta', source: 'stock', active: false },
				],
			} )
		);
		const { queryByText } = render( <Overview /> );
		expect( queryByText( 'Fold all' ) ).toBeNull();
		expect( queryByText( 'Unfold all' ) ).toBeNull();
	} );

	it( 'never renders an active row for inactive topologies', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{ name: 'beta', source: 'stock', active: false },
				],
			} )
		);
		const { container } = render( <Overview /> );
		expect(
			container.querySelector( '.nodes-tm__topology-stub' )
		).toBeNull();
		expect(
			container.querySelector( '.nodes-overview__stopped' )
		).not.toBeNull();
	} );
} );

describe( 'Overview persistence + drag-to-reorder', () => {
	it( 'initializes the unfolded set from readExpanded()', () => {
		overviewPrefs.readExpanded.mockReturnValue( new Set( [ 'alpha' ] ) );
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		expect( foldedByName( container ) ).toEqual( {
			alpha: false,
			beta: true,
		} );
	} );

	it( 'write-throughs the unfolded set on expand, unfold-all, and fold-all', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { getByText } = render( <Overview /> );
		act( () => rowProps( 'alpha' ).onExpand( 'alpha' ) );
		expect( overviewPrefs.writeExpanded ).toHaveBeenLastCalledWith(
			new Set( [ 'alpha' ] )
		);
		fireEvent.click( getByText( 'Unfold all' ) );
		expect(
			[ ...overviewPrefs.writeExpanded.mock.calls.at( -1 )[ 0 ] ].sort()
		).toEqual( [ 'alpha', 'beta' ] );
		fireEvent.click( getByText( 'Fold all' ) );
		expect( overviewPrefs.writeExpanded ).toHaveBeenLastCalledWith(
			new Set()
		);
	} );

	it( 'pointer-down on the grip marks the row as dragging', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'alpha', {
				preventDefault: jest.fn(),
				pointerId: 1,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		expect(
			container
				.querySelector( '[data-name="alpha"]' )
				.getAttribute( 'data-dragging' )
		).toBe( 'true' );
	} );

	it( 'a pointer drag (down → move past a lower row → up) reorders + persists', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		// Pointer moves are rAF-coalesced; run the frame synchronously here.
		const rafSpy = jest
			.spyOn( window, 'requestAnimationFrame' )
			.mockImplementation( ( cb ) => {
				cb();
				return 1;
			} );
		// Geometry: alpha [0–100], beta [100–200] (jsdom has no layout).
		const rectSpy = jest
			.spyOn( Element.prototype, 'getBoundingClientRect' )
			.mockImplementation( function () {
				const name = this.getAttribute?.( 'data-topology-row' );
				const idx = 'beta' === name ? 1 : 0;
				return {
					top: idx * 100,
					bottom: idx * 100 + 100,
					left: 0,
					right: 0,
					width: 0,
					height: 100,
					x: 0,
					y: idx * 100,
				};
			} );
		const { container } = render( <Overview /> );
		// Grab alpha, drag past beta's midpoint (y=160), release.
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'alpha', {
				preventDefault: jest.fn(),
				pointerId: 1,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 160 } ) );
		// Mid-drag the rows already show the new order.
		expect( rowNames( container ) ).toEqual( [ 'beta', 'alpha' ] );
		act( () => rowProps( 'alpha' ).onGripPointerUp() );
		expect( overviewPrefs.writeOrder ).toHaveBeenLastCalledWith( [
			'beta',
			'alpha',
		] );
		rectSpy.mockRestore();
		rafSpy.mockRestore();
	} );
} );
