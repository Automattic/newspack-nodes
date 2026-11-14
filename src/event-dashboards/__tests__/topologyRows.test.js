/* global Element */
/**
 * The topology-rows block — every active topology as a TopologyRow (folded
 * compact ↔ unfolded detail), in the user's persisted drag order (NOT
 * health), with a de-emphasized stopped group. TopologyRow is stubbed here
 * (its own suite owns the heading/tree DOM); this suite asserts the block
 * wired the right props (folded flag, handlers, order) and persisted order
 * and fold state.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { Editing } from '@newspack-nodes/shared/composition/page';
import topologyRows from '../blocks/topology-rows';
import { Core } from '../../runtime/core';

jest.mock( '../hooks/useTopologyManager', () => ( {
	useTopologyManager: jest.fn(),
} ) );
// The hold is the sources' own suite; mocked to see when the block holds.
jest.mock( '@newspack-nodes/shared/sources', () => ( {
	...jest.requireActual( '@newspack-nodes/shared/sources' ),
	useSourcesPaused: jest.fn(),
} ) );
// Persistence is its own suite; mocked to assert read-on-init + write-through.
jest.mock( '../overviewPrefs', () => ( {
	readOrder: jest.fn( () => [] ),
	writeOrder: jest.fn(),
	readExpanded: jest.fn( () => new Set() ),
	writeExpanded: jest.fn(),
	readCollapsed: jest.fn( () => new Set() ),
	writeCollapsed: jest.fn(),
} ) );
// TopologyControls has its own suite; stubbed to capture its wired props.
jest.mock( '../TopologyControls', () => {
	const el = require( '@wordpress/element' );
	return ( props ) => {
		( globalThis.__topologyControls ||= [] ).push( props );
		return el.createElement( 'span', { className: 'nodes-ctl-stub' } );
	};
} );
// Prop-capturing stub (its own suite owns the tree); keep real consoleHref.
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

/** The block's View, as a composed page renders it. */
const Overview = topologyRows.View;

const { useTopologyManager } = require( '../hooks/useTopologyManager' );
const { useSourcesPaused } = require( '@newspack-nodes/shared/sources' );
const overviewPrefs = require( '../overviewPrefs' );

// Find the captured TopologyControls props for a topology by name.
function controlFor( name ) {
	return globalThis.__topologyControls.find( ( c ) => c.name === name );
}

// A worker descriptor (server `dump_graph` shape, passed through verbatim).
function worker( overrides = {} ) {
	return {
		partition: 0,
		state: 'live',
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
	Core.reset();
	overviewPrefs.readOrder.mockReturnValue( [] );
	overviewPrefs.readExpanded.mockReturnValue( new Set() );
	overviewPrefs.writeOrder.mockClear();
	overviewPrefs.writeExpanded.mockClear();
	globalThis.__topologyControls = [];
	globalThis.__topologyRows = [];
} );
afterEach( () => {
	useTopologyManager.mockReset();
} );

// Active rows are TopologyRow stubs; DOM order = display order.
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

describe( 'the topology-rows block', () => {
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
						worker( { state: 'down' } ),
					] ),
				],
			} )
		);
		const { container } = render( <Overview /> );
		// Alphabetical — the stalled one stays put (no float-to-top).
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
		const stoppedItem = stopped.querySelector(
			'.nodes-overview__stopped-item'
		);
		expect( stoppedItem.classList.contains( 'newspack-nodes-badge' ) ).toBe(
			true
		);
		expect(
			stoppedItem.classList.contains( 'newspack-nodes-status-badge' )
		).toBe( false );
		const name = stopped.querySelector( '.nodes-overview__name' );
		expect( name.textContent ).toBe( 'beta' );
		expect( name.tagName ).not.toBe( 'A' );
		const ctl = controlFor( 'beta' );
		expect( ctl.active ).toBe( false );
		expect( ctl.editHref ).toContain( 'edit=1' );
	} );

	it( 'sends no mutation from a row or the stopped strip while its layout is edited', () => {
		const hook = hookValue( {
			topologies: [
				active( 'alpha', 'ok', [ worker() ] ),
				{ name: 'beta', source: 'stock', active: false },
			],
		} );
		useTopologyManager.mockReturnValue( hook );
		render(
			<Editing.Provider value={ true }>
				<Overview />
			</Editing.Provider>
		);
		rowProps( 'alpha' ).onDeactivate( 'alpha' );
		rowProps( 'alpha' ).onRestart( 'alpha' );
		controlFor( 'beta' ).onActivate( 'beta' );
		expect( hook.deactivate ).not.toHaveBeenCalled();
		expect( hook.restart ).not.toHaveBeenCalled();
		expect( hook.activate ).not.toHaveBeenCalled();
	} );

	it( 'sends a row’s mutation while its layout is read', () => {
		const hook = hookValue( {
			topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
		} );
		useTopologyManager.mockReturnValue( hook );
		render( <Overview /> );
		rowProps( 'alpha' ).onRestart( 'alpha' );
		expect( hook.restart ).toHaveBeenCalledWith( 'alpha' );
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
		const fold = container.querySelector( '.nodes-overview__foldall' );
		const unfold = container.querySelector( '.nodes-overview__unfoldall' );
		expect( fold.classList.contains( 'button' ) ).toBe( true );
		expect( fold.classList.contains( 'button-small' ) ).toBe( true );
		expect( unfold.classList.contains( 'button' ) ).toBe( true );
		expect( unfold.classList.contains( 'button-small' ) ).toBe( true );
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

describe( 'Overview — remaining interactions', () => {
	it( 'lists stopped topologies alphabetically', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{ name: 'zeta', source: 'stock', active: false },
					{ name: 'alpha', source: 'stock', active: false },
				],
			} )
		);
		const { container } = render( <Overview /> );
		const names = [
			...container.querySelectorAll(
				'.nodes-overview__stopped .nodes-overview__name'
			),
		].map( ( n ) => n.textContent );
		expect( names ).toEqual( [ 'alpha', 'zeta' ] );
	} );

	it( 'toggles a node-fold key on and off via onToggleFold', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		render( <Overview /> );
		act( () => rowProps( 'alpha' ).onToggleFold( 'node-x' ) );
		expect( rowProps( 'alpha' ).collapsed.has( 'node-x' ) ).toBe( true );
		act( () => rowProps( 'alpha' ).onToggleFold( 'node-x' ) );
		expect( rowProps( 'alpha' ).collapsed.has( 'node-x' ) ).toBe( false );
	} );

	it( 'dismisses the alert modal when its OK button is clicked', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		const { container } = render( <Overview /> );
		// A refused mutation raises the alert through the hook's onError: the
		// answer lands on the node that asked, not on a row's promise.
		const { onError } = useTopologyManager.mock.calls.at( -1 )[ 0 ];
		act( () => onError( { name: 'alpha', message: 'boom' } ) );
		expect( container.querySelector( '.nodes-tm__alert' ) ).not.toBeNull();
		fireEvent.click(
			container.querySelector(
				'.nodes-tm__alert .newspack-nodes-modal__actions .button'
			)
		);
		expect( container.querySelector( '.nodes-tm__alert' ) ).toBeNull();
	} );

	it( 'shows an activation warning in the alert modal, titled as a success', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		const { container } = render( <Overview /> );
		const { onWarning } = useTopologyManager.mock.calls.at( -1 )[ 0 ];
		act( () =>
			onWarning( {
				name: 'alpha',
				message:
					'these active topologies could not be checked for conflicts: broken-4410',
			} )
		);
		const dialog = container.querySelector( '.nodes-tm__alert' );
		expect(
			document.getElementById( dialog.getAttribute( 'aria-labelledby' ) )
				.textContent
		).toBe( 'Activated “alpha”, with a warning' );
		expect( dialog.textContent ).toContain(
			'these active topologies could not be checked for conflicts: broken-4410'
		);
	} );

	it( 'ignores a pointer move outside a drag', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		const rafSpy = jest.spyOn( window, 'requestAnimationFrame' );
		render( <Overview /> );
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 10 } ) );
		// No drag → no animation frame scheduled.
		expect( rafSpy ).not.toHaveBeenCalled();
		rafSpy.mockRestore();
	} );

	it( 'ignores a pointer-up outside a drag', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [ active( 'alpha', 'ok', [ worker() ] ) ],
			} )
		);
		render( <Overview /> );
		overviewPrefs.writeOrder.mockClear();
		act( () => rowProps( 'alpha' ).onGripPointerUp() );
		// Early return → no reorder committed/persisted.
		expect( overviewPrefs.writeOrder ).not.toHaveBeenCalled();
	} );

	it( 'coalesces rapid pointer moves into a single animation frame', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		// Schedule but never run the frame, so dragRafRef stays pending.
		const rafSpy = jest
			.spyOn( window, 'requestAnimationFrame' )
			.mockImplementation( () => 7 );
		render( <Overview /> );
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'alpha', {
				preventDefault: jest.fn(),
				pointerId: 1,
				clientY: 50,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 60 } ) );
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 70 } ) );
		// The second move returns early because a frame is already pending.
		expect( rafSpy ).toHaveBeenCalledTimes( 1 );
		rafSpy.mockRestore();
	} );

	it( 'skips the drag frame when the dragged row is no longer present', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const rafSpy = jest
			.spyOn( window, 'requestAnimationFrame' )
			.mockImplementation( ( cb ) => {
				cb();
				return 1;
			} );
		const { container } = render( <Overview /> );
		// Grab a name absent from the rendered rows → from index is -1.
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'ghost', {
				preventDefault: jest.fn(),
				pointerId: 1,
				clientY: 50,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		expect( () =>
			act( () =>
				rowProps( 'alpha' ).onGripPointerMove( { clientY: 60 } )
			)
		).not.toThrow();
		// The frame returned before applying any transform.
		expect(
			container.querySelector( '[data-topology-row="alpha"]' ).style
				.transform
		).toBe( '' );
		rafSpy.mockRestore();
	} );

	it( 'cancels a pending drag frame when unmounting mid-drag', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		const rafSpy = jest
			.spyOn( window, 'requestAnimationFrame' )
			.mockImplementation( () => 7 );
		const cancelSpy = jest
			.spyOn( window, 'cancelAnimationFrame' )
			.mockImplementation( () => {} );
		const { unmount } = render( <Overview /> );
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'alpha', {
				preventDefault: jest.fn(),
				pointerId: 1,
				clientY: 50,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 60 } ) );
		unmount();
		expect( cancelSpy ).toHaveBeenCalledWith( 7 );
		rafSpy.mockRestore();
		cancelSpy.mockRestore();
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

	it( 'holds every source of the page still from grip down to grip up', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					active( 'alpha', 'ok', [ worker() ] ),
					active( 'beta', 'ok', [ worker() ] ),
				],
			} )
		);
		render( <Overview /> );
		expect( useSourcesPaused ).toHaveBeenLastCalledWith( false );
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'alpha', {
				preventDefault: jest.fn(),
				pointerId: 1,
				clientY: 10,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		expect( useSourcesPaused ).toHaveBeenLastCalledWith( true );
		act( () => rowProps( 'alpha' ).onGripPointerUp() );
		expect( useSourcesPaused ).toHaveBeenLastCalledWith( false );
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
		const rowEl = ( name ) =>
			container.querySelector( `[data-topology-row="${ name }"]` );
		// Grab alpha at y=50, drag past beta's midpoint (y=160), release.
		act( () =>
			rowProps( 'alpha' ).onGripPointerDown( 'alpha', {
				preventDefault: jest.fn(),
				pointerId: 1,
				clientY: 50,
				currentTarget: { setPointerCapture: jest.fn() },
			} )
		);
		act( () => rowProps( 'alpha' ).onGripPointerMove( { clientY: 160 } ) );
		// Mid-drag moves via transform only; the list itself does NOT reorder.
		expect( rowEl( 'alpha' ).style.transform ).toBe( 'translateY(110px)' );
		expect( rowEl( 'beta' ).style.transform ).toBe( 'translateY(-100px)' );
		expect( rowNames( container ) ).toEqual( [ 'alpha', 'beta' ] );
		act( () => rowProps( 'alpha' ).onGripPointerUp() );
		// On drop: transforms cleared, reorder committed + persisted once.
		expect( rowEl( 'alpha' ).style.transform ).toBe( '' );
		expect( rowEl( 'beta' ).style.transform ).toBe( '' );
		expect( overviewPrefs.writeOrder ).toHaveBeenLastCalledWith( [
			'beta',
			'alpha',
		] );
		rectSpy.mockRestore();
		rafSpy.mockRestore();
	} );
} );
