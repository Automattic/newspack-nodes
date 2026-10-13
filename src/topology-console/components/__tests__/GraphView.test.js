import { fireEvent, act, render } from '@testing-library/react';
import { useState } from '@wordpress/element';
import GraphView from '../GraphView';
import { renderWithCatalog } from '../../__tests__/catalogTestUtils';
import { Core } from '../../../runtime/core';
import { MetadataNode } from '../../../runtime/metadata-node';
import {
	newMessage,
	pack,
	FROM,
	TO,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';
import { SIDECAR_POLLER } from '../../hooks/useSidecarRows';
import { NODE_H, NODE_SHADOW, NODE_W } from '../NodeCard';
import { ConfirmModal, ModalShell } from '../Modal';
import { MAX_FROM_SIZE } from '../../../runtime/node';
import names from '../../../runtime/reserved-node-names.json';

// Minimal frame stub: renders children (the console passes CanvasFrame).
const Frame = ( { children } ) => <div data-testid="frame">{ children }</div>;

/** A card's height at the default size, its drop shadow included. */
const CARD_H = NODE_H + NODE_SHADOW;

/**
 * Press a pointer on an element and release it there, as a click does.
 *
 * @param {Element} el Where the press lands.
 */
const press = ( el ) => {
	fireEvent.mouseDown( el );
	fireEvent.mouseUp( el );
	fireEvent.click( el );
};

/**
 * A dialog that unmounts itself on dismissal, as the Inspector's do.
 *
 * @return {?import('react').ReactElement} The dialog, while open.
 */
function OwnDialog() {
	const [ open, setOpen ] = useState( true );
	return (
		open && (
			<ModalShell title="Runtime" onDismiss={ () => setOpen( false ) }>
				<p>rows</p>
			</ModalShell>
		)
	);
}

/** Where the stub canvas draws each card, in world units. */
const CANVAS_AT = { n1: { x: 640, y: 220 } };

// Stub the leaf components so we assert wiring, not their internals. The
// stub's svg holds the "…" and the overlay, as the canvas's svg does.
jest.mock( '../SchematicCanvas', () => ( props ) => {
	global.__canvasProps = props;
	return (
		<div data-testid="canvas">
			<svg ref={ props.svgRef } tabIndex={ 0 } data-testid="canvas-svg">
				{ ! global.__dotsHidden && (
					<g
						key={ global.__dotsGeneration ?? 0 }
						data-testid="sidecars-n1"
						className="topology-node__sidecars"
						data-owner="n1"
						tabIndex={ 0 }
						onClick={ ( ev ) =>
							props.onOpenSidecars( 'n1', ev.currentTarget )
						}
					>
						<text>sidecars-n1</text>
					</g>
				) }
				{ props.overlay?.( {
					positionOf: ( id ) => {
						if ( ! CANVAS_AT[ id ] ) {
							return null;
						}
						const card = require( '../NodeCard' );
						return {
							...CANVAS_AT[ id ],
							w: card.NODE_W,
							h: card.NODE_H,
						};
					},
					surface: 'topology-card-stub',
					showDetail: ! global.__lod,
				} ) }
			</svg>
			<button onClick={ () => props.onSelect( 'n1' ) }>select-n1</button>
			<button onClick={ () => props.onSelect( 'n2' ) }>select-n2</button>
			<button onClick={ () => props.onConnect( 'a', 'b' ) }>
				connect
			</button>
			<button onClick={ () => props.onDeselect() }>deselect</button>
			<button
				onClick={ () => props.onSelectEdge( { from: 'a', to: 'b' } ) }
			>
				select-edge
			</button>
			<button onClick={ () => props.onSelectHull( 'quokka.tsl' ) }>
				select-hull
			</button>
		</div>
	);
} );
jest.mock( '../Inspector', () => ( props ) => {
	( global.__inspectorRenders ||= [] ).push( props );
	const { useCatalog } = require( '../../CatalogContext' );
	global.__inspectorProps = { ...props, ...useCatalog() };
	return (
		<div data-testid="inspector">
			insp:{ props.selectedId }
			{ props.sidecar && `/sidecar:${ props.sidecar }` }
			<button onClick={ () => props.onRemoveNode( props.selectedId ) }>
				remove-selected
			</button>
			<button onClick={ () => props.onOpenNode?.( 'n1' ) }>
				open-owner
			</button>
			<button onClick={ () => props.onOpenNode?.( 'n1:seen' ) }>
				open-seen
			</button>
			<button>verb</button>
		</div>
	);
} );
jest.mock( '../Palette', () => ( props ) => {
	const { useCatalog: useCat } = require( '../../CatalogContext' );
	global.__paletteProps = { ...props, ...useCat() };
	return <div data-testid="palette" />;
} );

const graph = { nodes: [ { id: 'n1', count: 0 } ], edges: [] };
const twoNodeGraph = {
	nodes: [
		{ id: 'n1', count: 0 },
		{ id: 'n2', count: 0 },
	],
	edges: [],
};

// Freeze the clock and hand the body a `tick()` that advances it one second:
// useGraphRates records a sample only once time has actually moved.
const withClock = ( body ) => {
	let t = 1_700_000_000_000;
	const real = Date.now;
	Date.now = () => t;
	try {
		body( () => ( t += 1000 ) );
	} finally {
		Date.now = real;
	}
};

// Land a poll reply as `_metadata`'s snapshot, the one graph rates sample.
const landPoll = ( graph_ ) => {
	let metadata = Core.node( names.METADATA );
	if ( ! metadata ) {
		metadata = new MetadataNode();
		metadata.name = names.METADATA;
	}
	act( () => metadata.setField( 'snapshot', graph_ ) );
	return graph_;
};

afterEach( () => Core.reset() );

describe( 'GraphView', () => {
	it( 'renders the canvas and forwards a connect gesture to onConnect', () => {
		const onConnect = jest.fn();
		const { getByText } = renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				onConnect={ onConnect }
				resetKey="k"
			/>
		);
		fireEvent.click( getByText( 'connect' ) );
		expect( onConnect ).toHaveBeenCalledWith( 'a', 'b' );
	} );

	it( 'inspector is always present (rail/panel); shows the node once selected', () => {
		const { getByTestId, getByText } = renderWithCatalog(
			<GraphView graph={ graph } frame={ Frame } resetKey="k" />
		);
		// Default-expanded: the Inspector renders before any selection.
		expect( getByTestId( 'inspector' ) ).not.toBeNull();
		expect( getByTestId( 'inspector' ).textContent ).not.toContain( 'n1' );
		fireEvent.click( getByText( 'select-n1' ) );
		expect( getByTestId( 'inspector' ).textContent ).toContain( 'n1' );
	} );

	it( 'lets composeTargets reach Inspector through the catalog context', () => {
		const composeTargets = [ '_command_interpreter', 'n1', 'n1:config' ];
		renderWithCatalog(
			<GraphView graph={ graph } frame={ Frame } resetKey="k" />,
			{ composeTargets }
		);
		expect( global.__inspectorProps.composeTargets ).toBe( composeTargets );
	} );

	it( 'renders the palette only when showPalette is set', () => {
		const { queryByTestId, rerender } = renderWithCatalog(
			<GraphView graph={ graph } frame={ Frame } resetKey="k" />
		);
		expect( queryByTestId( 'palette' ) ).toBeNull();
		rerender(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				showPalette
			/>
		);
		expect( queryByTestId( 'palette' ) ).not.toBeNull();
	} );

	it( 're-syncs internal selection when the controlled `selection` prop changes', () => {
		const { getByText, getByTestId, rerender } = renderWithCatalog(
			<GraphView
				graph={ twoNodeGraph }
				frame={ Frame }
				resetKey="k"
				selection={ null }
			/>
		);
		// External re-point n1→n2 moves the inspector via the re-sync effect.
		fireEvent.click( getByText( 'select-n1' ) );
		expect( getByTestId( 'inspector' ).textContent ).toContain( 'n1' );
		rerender(
			<GraphView
				graph={ twoNodeGraph }
				frame={ Frame }
				resetKey="k"
				selection={ 'n2' }
			/>
		);
		expect( getByTestId( 'inspector' ).textContent ).toContain( 'n2' );
		// External clear (selection→null) empties content; the panel stays.
		rerender(
			<GraphView
				graph={ twoNodeGraph }
				frame={ Frame }
				resetKey="k"
				selection={ null }
			/>
		);
		expect( getByTestId( 'inspector' ) ).not.toBeNull();
		expect( getByTestId( 'inspector' ).textContent ).not.toContain( 'n2' );
	} );

	it( 'canvas deselect notifies the consumer via onSelectionChange(null)', () => {
		const onSelectionChange = jest.fn();
		const { getByText } = renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				onSelectionChange={ onSelectionChange }
			/>
		);
		fireEvent.click( getByText( 'select-n1' ) );
		expect( onSelectionChange ).toHaveBeenLastCalledWith( 'n1' );
		fireEvent.click( getByText( 'deselect' ) );
		expect( onSelectionChange ).toHaveBeenLastCalledWith( null );
	} );

	it( 'removing the selected node notifies the consumer via onSelectionChange(null)', () => {
		const onSelectionChange = jest.fn();
		const onRemoveNode = jest.fn();
		const { getByText } = renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				onRemoveNode={ onRemoveNode }
				onSelectionChange={ onSelectionChange }
			/>
		);
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'remove-selected' ) );
		expect( onRemoveNode ).toHaveBeenCalledWith( 'n1' );
		expect( onSelectionChange ).toHaveBeenLastCalledWith( null );
	} );

	it( 'an external null-clear leaves a selected edge alone', () => {
		const onRemoveEdge = jest.fn();
		// Null is the node selection's EMPTY value, which is exactly what an
		// edge selection leaves behind — it can never mean "drop the edge".
		const { getByText, rerender } = renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				editMode
				onRemoveEdge={ onRemoveEdge }
			/>
		);
		fireEvent.click( getByText( 'select-edge' ) );
		rerender(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				editMode
				selection={ null }
				onRemoveEdge={ onRemoveEdge }
			/>
		);
		fireEvent.keyDown( document, { key: 'Delete' } );
		expect( onRemoveEdge ).toHaveBeenCalledWith( 'a', 'b' );
	} );

	it( 'an external re-point to a NODE clears a selected edge', () => {
		const onRemoveEdge = jest.fn();
		const onRemoveNode = jest.fn();
		const { getByText, rerender } = renderWithCatalog(
			<GraphView
				graph={ twoNodeGraph }
				frame={ Frame }
				resetKey="k"
				editMode
				onRemoveEdge={ onRemoveEdge }
				onRemoveNode={ onRemoveNode }
			/>
		);
		fireEvent.click( getByText( 'select-edge' ) );
		rerender(
			<GraphView
				graph={ twoNodeGraph }
				frame={ Frame }
				resetKey="k"
				editMode
				selection="n2"
				onRemoveEdge={ onRemoveEdge }
				onRemoveNode={ onRemoveNode }
			/>
		);
		fireEvent.keyDown( document, { key: 'Delete' } );
		expect( onRemoveEdge ).not.toHaveBeenCalled();
		expect( onRemoveNode ).toHaveBeenCalledWith( 'n2' );
	} );

	it( 'a resetKey change clears a selected edge', () => {
		const onRemoveEdge = jest.fn();
		const { getByText, rerender } = renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="wombat|view|alpha"
				editMode
				onRemoveEdge={ onRemoveEdge }
			/>
		);
		fireEvent.click( getByText( 'select-edge' ) );
		rerender(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="quokka|edit|beta"
				editMode
				onRemoveEdge={ onRemoveEdge }
			/>
		);
		fireEvent.keyDown( document, { key: 'Delete' } );
		expect( onRemoveEdge ).not.toHaveBeenCalled();
	} );

	it( 'a resetKey change clears a selected hull', () => {
		const onRemoveInclude = jest.fn();
		const { getByText, rerender } = renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="wombat|view|alpha"
				editMode
				includes={ [ 'quokka.tsl' ] }
				onRemoveInclude={ onRemoveInclude }
			/>
		);
		fireEvent.click( getByText( 'select-hull' ) );
		expect( global.__canvasProps.selectedHull ).toBe( 'quokka.tsl' );
		rerender(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="numbat|edit|beta"
				editMode
				includes={ [ 'quokka.tsl' ] }
				onRemoveInclude={ onRemoveInclude }
			/>
		);
		expect( global.__canvasProps.selectedHull ).toBeNull();
		fireEvent.keyDown( document, { key: 'Delete' } );
		expect( onRemoveInclude ).not.toHaveBeenCalled();
	} );

	// The console mirrors GraphView's selection straight back as `selection`,
	// so an edge click — which reports the NODE selection as null — used to
	// echo in as an external clear and wipe the edge the user just picked.
	it( 'keeps an edge selected after a node selection, through the controlled round-trip', () => {
		const onRemoveEdge = jest.fn();
		const Controlled = ( props ) => {
			const [ selection, setSelection ] = useState( null );
			return (
				<GraphView
					{ ...props }
					selection={ selection }
					onSelectionChange={ setSelection }
				/>
			);
		};
		const { getByText } = renderWithCatalog(
			<Controlled
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				editMode
				onRemoveEdge={ onRemoveEdge }
			/>
		);
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'select-edge' ) );
		expect( global.__canvasProps.selectedEdge ).toEqual( {
			from: 'a',
			to: 'b',
		} );
		fireEvent.keyDown( document, { key: 'Delete' } );
		expect( onRemoveEdge ).toHaveBeenCalledWith( 'a', 'b' );
	} );

	it( 'forwards onDropNode to the Palette (which owns the pointer-drag drop)', () => {
		const onDropNode = jest.fn();
		renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				showPalette
				onDropNode={ onDropNode }
			/>
		);
		expect( global.__paletteProps.onDropNode ).toBe( onDropNode );
	} );

	it( 'forwards paletteLoading to the Palette loading prop (not derived from catalog)', () => {
		// Non-empty catalog: a true result can't come from ! catalog.length.
		renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				showPalette
				paletteLoading
			/>,
			{ classes: [ { shell_name: 'Echo' } ] }
		);
		expect( global.__paletteProps.loading ).toBe( true );
	} );

	it( 'Delete key on a selected node calls onRemoveNode', () => {
		const onRemoveNode = jest.fn();
		const { getByText } = renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				onRemoveNode={ onRemoveNode }
				resetKey="k"
			/>
		);
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.keyDown( document, { key: 'Delete' } );
		expect( onRemoveNode ).toHaveBeenCalledWith( 'n1' );
	} );

	it( 'Delete key on a selected BORROWED node does not call onRemoveNode', () => {
		const onRemoveNode = jest.fn();
		const borrowedGraph = {
			nodes: [ { id: 'n1', count: 0, origin: [ 'performance' ] } ],
			edges: [],
		};
		const { getByText } = renderWithCatalog(
			<GraphView
				graph={ borrowedGraph }
				frame={ Frame }
				onRemoveNode={ onRemoveNode }
				resetKey="k"
			/>
		);
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.keyDown( document, { key: 'Delete' } );
		expect( onRemoveNode ).not.toHaveBeenCalled();
	} );

	it( 'forwards hulls through to SchematicCanvas', () => {
		const hulls = [ { include: 'performance', nodeIds: [ 'n1' ] } ];
		renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				hulls={ hulls }
			/>
		);
		expect( global.__canvasProps.hulls ).toBe( hulls );
	} );

	// The persisted pan/zoom is stored as a delta from autofit; the canvas is
	// the only thing that can turn it back into a viewport. Dropped here, a
	// reload silently autofits and the saved viewport is lost.
	it( 'forwards viewportDelta through to SchematicCanvas', () => {
		const viewportDelta = { dcx: 137, dcy: -211, zoom: 2.5 };
		renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				viewportDelta={ viewportDelta }
			/>
		);
		expect( global.__canvasProps.viewportDelta ).toBe( viewportDelta );
	} );

	it( 'forwards ONE `includes` prop to both Palette (declaredIncludes) and Inspector (includes)', () => {
		const topologies = [ { name: 'performance', includes: [] } ];
		const onDropTopology = jest.fn();
		const includeTree = { performance: {} };
		const onRemoveInclude = jest.fn();
		renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				showPalette
				currentTopology="wombat-top"
				includes={ [ 'performance' ] }
				onDropTopology={ onDropTopology }
				includeTree={ includeTree }
				onRemoveInclude={ onRemoveInclude }
			/>,
			{ topologies }
		);
		expect( global.__paletteProps.topologies ).toBe( topologies );
		expect( global.__paletteProps.currentTopology ).toBe( 'wombat-top' );
		expect( global.__paletteProps.declaredIncludes ).toEqual( [
			'performance',
		] );
		expect( global.__paletteProps.onDropTopology ).toBe( onDropTopology );
		expect( global.__inspectorProps.tree ).toBe( includeTree );
		expect( global.__inspectorProps.includes ).toEqual( [ 'performance' ] );
		expect( global.__inspectorProps.onRemoveInclude ).toBe(
			onRemoveInclude
		);
	} );

	it( 'inspector collapse: expanded shows Inspector + a Collapse toggle; collapsed shows an Expand rail (no Inspector)', () => {
		const onInspectorToggle = jest.fn();
		const { getByTestId, getByLabelText, queryByTestId, rerender } =
			renderWithCatalog(
				<GraphView
					graph={ twoNodeGraph }
					frame={ Frame }
					selection="n2"
					inspectorCollapsed={ false }
					onInspectorToggle={ onInspectorToggle }
				/>
			);
		expect( getByTestId( 'inspector' ) ).not.toBeNull();
		const collapse = getByLabelText( 'Collapse inspector' );
		expect( collapse.getAttribute( 'aria-expanded' ) ).toBe( 'true' );
		fireEvent.click( collapse );
		expect( onInspectorToggle ).toHaveBeenCalled();
		rerender(
			<GraphView
				graph={ twoNodeGraph }
				frame={ Frame }
				selection="n2"
				inspectorCollapsed
				onInspectorToggle={ onInspectorToggle }
			/>
		);
		expect( queryByTestId( 'inspector' ) ).toBeNull();
		expect(
			getByLabelText( 'Expand inspector' ).getAttribute( 'aria-expanded' )
		).toBe( 'false' );
	} );

	it( 'accumulates the process-stats rate series in GraphView so it survives inspector collapse/expand', () => {
		const src = ( count ) => ( {
			id: 'src',
			count,
			has_target: true,
			accepts_fill: false,
		} );
		// g0 seeds the baseline WITH data; g1 yields a real In-rate delta.
		const g0 = { nodes: [ src( 5 ) ], edges: [] };
		const g1 = { nodes: [ src( 10 ) ], edges: [] };
		withClock( ( tick ) => {
			landPoll( g0 );
			const { rerender } = renderWithCatalog(
				<GraphView graph={ g0 } frame={ Frame } resetKey="k" />
			);
			// A second poll, one second on, accumulates one In-rate sample.
			tick();
			landPoll( g1 );
			rerender( <GraphView graph={ g1 } frame={ Frame } resetKey="k" /> );
			const len = global.__inspectorProps.rateSeries.in.length;
			expect( len ).toBeGreaterThan( 0 );
			// Collapse→expand (same graph) keeps the GraphView-held series.
			rerender(
				<GraphView
					graph={ g1 }
					frame={ Frame }
					resetKey="k"
					inspectorCollapsed
				/>
			);
			rerender(
				<GraphView
					graph={ g1 }
					frame={ Frame }
					resetKey="k"
					inspectorCollapsed={ false }
				/>
			);
			expect( global.__inspectorProps.rateSeries.in.length ).toBe( len );
		} );
	} );
} );

describe( 'GraphView — hull selection', () => {
	it( 'clicking the background clears a selected HULL, not just a node', () => {
		const hulls = [ { include: 'performance', nodeIds: [ 'n1' ] } ];
		const { getByText } = renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				hulls={ hulls }
			/>
		);

		// Select the hull the way the canvas does (fill click).
		act( () => {
			global.__canvasProps.onSelectHull( 'performance' );
		} );
		expect( global.__inspectorProps.selectedHull ).toBe( 'performance' );

		fireEvent.click( getByText( 'deselect' ) );

		expect( global.__inspectorProps.selectedHull ).toBeNull();
	} );

	it( 'selecting an include in the Inspector selects its hull on the canvas too', () => {
		const hulls = [ { include: 'performance', nodeIds: [ 'n1' ] } ];
		renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				hulls={ hulls }
			/>
		);

		act( () => {
			global.__inspectorProps.onSelectHull( 'performance' );
		} );

		expect( global.__inspectorProps.selectedHull ).toBe( 'performance' );
		expect( global.__canvasProps.selectedHull ).toBe( 'performance' );
	} );

	// useGraphRates only records a sample once a full second has elapsed, so a
	// poll has to advance the clock the way a real one does.
	const hullNodesGraph = ( a, b ) => ( {
		nodes: [
			{ id: 'inside', count: a, has_target: true, accepts_fill: false },
			{ id: 'outside', count: b, has_target: true, accepts_fill: false },
		],
		edges: [],
	} );
	const perfHull = [ { include: 'performance', nodeIds: [ 'inside' ] } ];
	const hullView = ( graph_ ) => (
		<GraphView
			graph={ graph_ }
			frame={ Frame }
			resetKey="k"
			hulls={ perfHull }
		/>
	);
	// One poll: the reply lands on `_metadata`, and the canvas draws it.
	const hullPoll = ( a, b ) => hullView( landPoll( hullNodesGraph( a, b ) ) );

	it( 'scopes the hull rate series to the hull MEMBERS, not the whole graph', () => {
		withClock( ( tick ) => {
			// Both are sources, so both feed the graph-wide In rate; only `inside`
			// is a member. The deltas differ by an order of magnitude, so a series
			// built from the wrong scope can't coincidentally match the right one.
			const { rerender } = renderWithCatalog( hullPoll( 10, 100 ) );
			act( () => {
				global.__canvasProps.onSelectHull( 'performance' );
			} );
			// A second poll, one second on: `inside` +30/s, `outside` +400/s.
			tick();
			rerender( hullPoll( 40, 500 ) );

			const hullIn = global.__inspectorProps.hullRateSeries.in;
			const graphIn = global.__inspectorProps.rateSeries.in;
			expect( hullIn[ hullIn.length - 1 ] ).toBe( 30 );
			expect( graphIn[ graphIn.length - 1 ] ).toBe( 430 );
		} );
	} );

	/**
	 * The graph-wide series used to be differenced from the AGGREGATE totals,
	 * so one worker's respawn (its cumulative counter back to zero) was netted
	 * against every other node's growth and the whole fleet reported a
	 * wrong-but-positive rate for that tick. Per-node deltas clamp only the
	 * node that reset.
	 */
	it( 'charges a counter reset to the node that reset, not to the fleet', () => {
		withClock( ( tick ) => {
			const { rerender } = renderWithCatalog( hullPoll( 10, 100 ) );
			tick();
			rerender( hullPoll( 40, 500 ) );
			tick();
			// `inside` respawned to 0; `outside` kept climbing by 400/s.
			rerender( hullPoll( 0, 900 ) );

			const graphIn = global.__inspectorProps.rateSeries.in;
			expect( graphIn[ graphIn.length - 1 ] ).toBe( 400 );
		} );
	} );

	// @longform A sparkline point is a dump_metadata SNAPSHOT, and the canvas
	// graph is rebuilt far more often than one arrives — a catalog republishing
	// was enough. Sampling per rebuild filed four empty points for every real
	// one, so the chart read as a spike every fifth second and its 60-point ring
	// covered a minute instead of the five its label claims.
	it( 'records one sample per metadata snapshot, not per canvas rebuild', () => {
		withClock( ( tick ) => {
			const metadata = new MetadataNode();
			metadata.name = names.METADATA;
			const snapshot = ( a, b ) => hullNodesGraph( a, b );
			let published = snapshot( 10, 100 );
			act( () => metadata.setField( 'snapshot', published ) );

			const { rerender } = renderWithCatalog( hullView( published ) );
			// Three canvas rebuilds, seconds apart, one unchanged snapshot.
			for ( let i = 0; i < 3; i++ ) {
				tick();
				rerender( hullView( { ...published } ) );
			}
			expect( global.__inspectorProps.rateSeries.in ).toEqual( [] );

			// A real poll lands: ONE point, over the whole elapsed interval.
			tick();
			published = snapshot( 40, 500 );
			act( () => metadata.setField( 'snapshot', published ) );
			rerender( hullView( published ) );

			expect( global.__inspectorProps.rateSeries.in ).toEqual( [
				107.5,
			] );
			Core.reset();
		} );
	} );

	it( 'an optimistic patch between two polls neither zeroes a rate nor idles a card', () => {
		withClock( ( tick ) => {
			const metadata = new MetadataNode();
			metadata.name = names.METADATA;
			const poll = ( a, b ) => ( {
				inside: { class: 'Echo', counter: a, accepts_fill: false },
				outside: { class: 'Echo', counter: b, accepts_fill: false },
			} );
			act( () => metadata.publish( poll( 10, 100 ) ) );
			const { rerender } = renderWithCatalog(
				hullView( metadata.metadata )
			);
			tick();
			act( () => metadata.publish( poll( 47, 100 ) ) );
			rerender( hullView( metadata.metadata ) );
			const rates = global.__canvasProps.rateRef.current;
			expect( rates.get( 'inside' ).rate ).toBe( 37 );

			// A rename, a trace toggle or a palette drop, before the next poll.
			tick();
			act( () =>
				metadata.optimisticPatch( 'inside', { debug_state: 3 } )
			);
			rerender( hullView( metadata.metadata ) );
			act( () => metadata.optimisticPatchAll( { debug_state: 1 } ) );
			rerender( hullView( metadata.metadata ) );

			expect( rates.get( 'inside' ).rate ).toBe( 37 );
			expect( global.__inspectorProps.rateSeries.in ).toEqual( [ 37 ] );
			Core.reset();
		} );
	} );

	it( 'files no rate sample off an optimistic patch before any poll reply', () => {
		withClock( ( tick ) => {
			const metadata = new MetadataNode();
			metadata.name = names.METADATA;
			// A palette drop and a rename land before `_metadata` hears back.
			act( () =>
				metadata.optimisticPatch( 'inside', {
					class: 'Echo',
					counter: 13,
				} )
			);
			const { rerender } = renderWithCatalog(
				hullView( metadata.metadata )
			);
			tick();
			act( () => metadata.optimisticPatch( 'inside', { counter: 71 } ) );
			rerender( hullView( metadata.metadata ) );

			expect( [
				...global.__canvasProps.rateRef.current.keys(),
			] ).toEqual( [] );
			expect( global.__inspectorProps.rateSeries.in ).toEqual( [] );
		} );
	} );

	it( 'keeps every rate history through a zero-node poll reply', () => {
		withClock( ( tick ) => {
			const metadata = new MetadataNode();
			metadata.name = names.METADATA;
			const poll = ( a ) => ( {
				inside: { class: 'Echo', counter: a, accepts_fill: false },
			} );
			act( () => metadata.publish( poll( 10 ) ) );
			const { rerender } = renderWithCatalog(
				hullView( metadata.metadata )
			);
			tick();
			act( () => metadata.publish( poll( 33 ) ) );
			rerender( hullView( metadata.metadata ) );

			// Nothing has answered for this scope yet: no node, not an empty graph.
			tick();
			act( () => metadata.publish( {} ) );
			rerender( hullView( hullNodesGraph( 90, 900 ) ) );

			const rates = global.__canvasProps.rateRef.current;
			expect( [ ...rates.keys() ] ).toEqual( [ 'inside' ] );
			expect( rates.get( 'inside' ).history ).toEqual( [ 23 ] );
		} );
	} );

	it( 'shows the history recorded BEFORE the hull was selected', () => {
		withClock( ( tick ) => {
			// Three polls with NO hull selected. useGraphRates is recording the
			// whole time, so selecting the hull afterwards must reveal that
			// history — not start a fresh accumulation from zero.
			const { rerender } = renderWithCatalog( hullPoll( 10, 100 ) );
			tick();
			rerender( hullPoll( 40, 500 ) );
			tick();
			rerender( hullPoll( 90, 900 ) );

			expect( global.__inspectorProps.hullRateSeries.in ).toEqual( [] );

			act( () => {
				global.__canvasProps.onSelectHull( 'performance' );
			} );

			// Both prior polls' rates, immediately: +30/s then +50/s.
			expect( global.__inspectorProps.hullRateSeries.in ).toEqual( [
				30, 50,
			] );
		} );
	} );
} );

/**
 * A hull IS the include — deleting the selection should remove it, the same way
 * Delete removes a selected node or edge. Only a DIRECTLY-declared include can
 * go: a nested one isn't in this topology's `include` lines, so there is nothing
 * to remove. And only in edit mode — deleting an include edits the draft.
 */
describe( 'GraphView — Delete on a selected hull', () => {
	const hulls = [
		{ include: 'performance', nodeIds: [ 'n1' ] },
		{ include: 'nested-only', nodeIds: [ 'n1' ] },
	];

	const renderWith = ( props ) =>
		renderWithCatalog(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				hulls={ hulls }
				includes={ [ 'performance' ] }
				{ ...props }
			/>
		);

	it( 'removes the include the hull stands for', () => {
		const onRemoveInclude = jest.fn();
		renderWith( { editMode: true, onRemoveInclude } );

		act( () => global.__canvasProps.onSelectHull( 'performance' ) );
		fireEvent.keyDown( document, { key: 'Delete' } );

		expect( onRemoveInclude ).toHaveBeenCalledWith( 'performance' );
	} );

	it( 'leaves a NESTED include alone — it is not declared here', () => {
		const onRemoveInclude = jest.fn();
		renderWith( { editMode: true, onRemoveInclude } );

		act( () => global.__canvasProps.onSelectHull( 'nested-only' ) );
		fireEvent.keyDown( document, { key: 'Delete' } );

		expect( onRemoveInclude ).not.toHaveBeenCalled();
	} );

	it( 'does nothing in live mode — there is no draft to edit', () => {
		const onRemoveInclude = jest.fn();
		renderWith( { onRemoveInclude } );

		act( () => global.__canvasProps.onSelectHull( 'performance' ) );
		fireEvent.keyDown( document, { key: 'Delete' } );

		expect( onRemoveInclude ).not.toHaveBeenCalled();
	} );

	it( 'clears the hull selection after removing it', () => {
		renderWith( { editMode: true, onRemoveInclude: jest.fn() } );

		act( () => global.__canvasProps.onSelectHull( 'performance' ) );
		fireEvent.keyDown( document, { key: 'Delete' } );

		expect( global.__inspectorProps.selectedHull ).toBeNull();
	} );
} );

describe( 'GraphView — sidecars', () => {
	afterEach( () => {
		delete global.__dotsGeneration;
		delete global.__dotsHidden;
		delete global.__lod;
	} );

	/** An owner with two sidecars, beside a node owning none. */
	const owned = {
		nodes: [
			{
				id: 'n1',
				count: 0,
				sidecars: [
					{ name: 'n1:curl', class: 'Curl' },
					{ name: 'n1:seen', class: 'Table' },
				],
			},
			{ id: 'n2', count: 0 },
		],
		edges: [],
	};
	const flush = () => act( async () => {} );
	const inspectorText = ( getByTestId ) =>
		getByTestId( 'inspector' ).textContent;

	/**
	 * Render GraphView over a graph, opening n1's "…" and picking `name`.
	 *
	 * @param {string} name  The sidecar to pick.
	 * @param {Object} props Extra GraphView props.
	 * @return {Object} What renderWithCatalog returns.
	 */
	const pick = async ( name, props = {} ) => {
		const rendered = renderWithCatalog(
			<GraphView
				graph={ owned }
				frame={ Frame }
				resetKey="k"
				{ ...props }
			/>
		);
		fireEvent.click( rendered.getByText( 'sidecars-n1' ) );
		await flush();
		fireEvent.click( rendered.getByText( name ) );
		await flush();
		return rendered;
	};

	it( "lists the card's sidecars without selecting it, the first card focused", async () => {
		const onSelectionChange = jest.fn();
		const { getByText, getByTestId } = renderWithCatalog(
			<GraphView
				graph={ owned }
				frame={ Frame }
				resetKey="k"
				onSelectionChange={ onSelectionChange }
			/>
		);
		fireEvent.click( getByText( 'sidecars-n1' ) );
		await flush();
		const cards = [
			...document.body.querySelectorAll( '.topology-sidecars__card' ),
		];
		expect( cards.map( ( c ) => c.getAttribute( 'aria-label' ) ) ).toEqual(
			[ 'n1:curl (Curl)', 'n1:seen (Table)' ]
		);
		expect( document.activeElement ).toBe( cards[ 0 ] );
		expect( onSelectionChange ).not.toHaveBeenCalled();
		expect( inspectorText( getByTestId ) ).toBe(
			'insp:remove-selectedopen-owneropen-seenverb'
		);
	} );

	describe( 'the one sidecar poller', () => {
		/** What reached `_cwd`, here a capture. */
		let sent;
		let now;
		let realNow;

		beforeEach( () => {
			sent = [];
			Core.registerNode( '_cwd', {
				name: '_cwd',
				fill: ( m ) => sent.push( m ),
			} );
			now = 1_700_000_000_000;
			realNow = Date.now;
			Date.now = () => now;
		} );

		afterEach( () => {
			Date.now = realNow;
		} );

		/**
		 * Answer the sidecar poller about the names it asks for now.
		 *
		 * @param {Object} map The `dump_metadata` reply map.
		 */
		const answer = ( map ) => {
			const poller = Core.node( SIDECAR_POLLER );
			const reply = newMessage();
			reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			reply[ TO ] = encodeURIComponent( poller.subject );
			reply[ VALUE ] = { payload: map };
			act( () => poller.fill( reply ) );
		};

		const card = ( i ) =>
			document.body.querySelectorAll( '.topology-sidecars__card' )[ i ];
		const readout = ( i ) =>
			document.body.querySelectorAll(
				'.topology-sidecars > .topology-readouts > .topology-node-readout'
			)[ i ];

		it( "asks for the grid's sidecars on the click, and none once it closes", async () => {
			const { getByText } = renderWithCatalog(
				<GraphView graph={ owned } frame={ Frame } resetKey="k" />
			);
			await act( async () => {} );
			expect( sent ).toHaveLength( 0 );
			fireEvent.click( getByText( 'sidecars-n1' ) );
			await act( async () => {} );
			expect( sent ).toHaveLength( 1 );
			expect( sent[ 0 ][ VALUE ] ).toMatchObject( {
				name: 'dump_metadata',
				arguments: [ '-o', 'n1' ],
			} );
			fireEvent.keyDown( document, { key: 'Escape' } );
			expect( Core.node( SIDECAR_POLLER ) ).toBeFalsy();
		} );

		it( 'draws each card live off its answers, a rate from the second', async () => {
			const { getByText } = renderWithCatalog(
				<GraphView graph={ owned } frame={ Frame } resetKey="k" />
			);
			fireEvent.click( getByText( 'sidecars-n1' ) );
			await act( async () => {} );
			answer( { 'n1:seen': { class: 'Table', counter: 6100 } } );
			expect(
				readout( 1 ).querySelector( '.topology-node__counter' )
					.textContent
			).toBe( '6,100' );
			expect(
				readout( 1 ).querySelector( '.topology-node__rate' ).textContent
			).toBe( '' );
			now += 2000;
			answer( { 'n1:seen': { class: 'Table', counter: 6142 } } );
			expect(
				readout( 1 ).querySelector( '.topology-node__rate' ).textContent
			).toBe( '21.0 /s' );
			now += 1000;
			answer( { 'n1:seen': { class: 'Table', counter: 6172 } } );
			expect(
				readout( 1 ).querySelector( '.topology-node__counter' )
					.textContent
			).toBe( '6,172' );
			expect(
				readout( 1 ).querySelector( '.topology-node__spark' )
			).not.toBeNull();
			expect(
				readout( 0 ).querySelector( '.topology-node__counter' )
					.textContent
			).toBe( '—' );
		} );

		it( "hands the shown sidecar's Inspector the rate its grid card shows", async () => {
			const { getByText } = renderWithCatalog(
				<GraphView graph={ owned } frame={ Frame } resetKey="k" />
			);
			fireEvent.click( getByText( 'sidecars-n1' ) );
			await act( async () => {} );
			answer( { 'n1:seen': { class: 'Table', counter: 4100 } } );
			now += 2000;
			answer( { 'n1:seen': { class: 'Table', counter: 4134 } } );
			expect(
				readout( 1 ).querySelector( '.topology-node__rate' ).textContent
			).toBe( '17.0 /s' );
			fireEvent.click( card( 1 ) );
			await act( async () => {} );
			expect( global.__inspectorProps.sidecar ).toBe( 'n1:seen' );
			expect( global.__inspectorProps.rateInfo ).toMatchObject( {
				rate: 17,
				history: [ 17 ],
			} );
		} );

		it( "keeps a picked sidecar's answered row across a new ask until its answer", async () => {
			const { getByText } = renderWithCatalog(
				<GraphView graph={ owned } frame={ Frame } resetKey="k" />
			);
			fireEvent.click( getByText( 'sidecars-n1' ) );
			await act( async () => {} );
			answer( {
				n1: { class: 'Crawler', sidecars: owned.nodes[ 0 ].sidecars },
				'n1:seen': { class: 'Table', counter: 8125 },
			} );
			const poller = Core.node( SIDECAR_POLLER );
			global.__inspectorRenders = [];
			fireEvent.click( card( 1 ) );
			await act( async () => {} );
			expect( Core.node( SIDECAR_POLLER ) ).toBe( poller );
			expect( sent[ sent.length - 1 ][ VALUE ].arguments ).toEqual( [
				'-o',
				'n1:seen',
				'n1',
			] );
			const shown = ( props ) =>
				props.sidecarGraph?.nodes.find( ( n ) => 'n1:seen' === n.id )
					?.count;
			const after = global.__inspectorRenders.filter(
				( props ) => 'n1:seen' === props.sidecar
			);
			expect( after.length ).toBeGreaterThan( 0 );
			expect( after.map( shown ) ).toEqual( after.map( () => 8125 ) );
			answer( { 'n1:seen': { class: 'Table', counter: 8191 } } );
			expect( shown( global.__inspectorProps ) ).toBe( 8191 );
		} );

		/** n1 answered, its `n1:seen` owning `n1:seen:offsetlog`, all with rows. */
		const answerSeen = () =>
			answer( {
				n1: { class: 'Crawler', sidecars: owned.nodes[ 0 ].sidecars },
				'n1:seen': {
					class: 'Table',
					counter: 8125,
					sidecars: [
						{ name: 'n1:seen:offsetlog', class: 'Partition' },
					],
				},
				'n1:seen:offsetlog': { class: 'Partition', counter: 61 },
			} );

		it( 'loads a picked sidecar no answer has covered yet', async () => {
			const { getByText } = renderWithCatalog(
				<GraphView graph={ owned } frame={ Frame } resetKey="k" />
			);
			fireEvent.click( getByText( 'sidecars-n1' ) );
			await act( async () => {} );
			fireEvent.click( card( 1 ) );
			await act( async () => {} );
			expect( global.__inspectorProps.sidecar ).toBe( 'n1:seen' );
			expect( global.__inspectorProps.sidecarGraph ).toBeNull();
		} );

		/** The open grids, outermost first. */
		const popovers = () => [
			...document.body.querySelectorAll( '.topology-sidecars' ),
		];

		/**
		 * Open n1's grid, answer it, and open n1:seen's from its card's "…".
		 *
		 * @param {Object} [props] Extra GraphView props.
		 * @return {Promise<Object>} What renderWithCatalog returns.
		 */
		const openNested = async ( props = {} ) => {
			const rendered = renderWithCatalog(
				<GraphView
					graph={ owned }
					frame={ Frame }
					resetKey="k"
					{ ...props }
				/>
			);
			fireEvent.click( rendered.getByText( 'sidecars-n1' ) );
			await flush();
			answerSeen();
			fireEvent.click(
				popovers()[ 0 ].querySelector( '.topology-node__sidecars' )
			);
			await flush();
			return rendered;
		};

		it( "opens a sidecar's own sidecars from the \u201c\u2026\u201d on its grid card, below that card", async () => {
			const { getByTestId } = await openNested();
			const [ outer, inner ] = popovers();
			expect( outer.getAttribute( 'aria-label' ) ).toBe( 'Owned by n1' );
			expect( inner.getAttribute( 'aria-label' ) ).toBe(
				'Owned by n1:seen'
			);
			expect(
				inner
					.querySelector( '.topology-sidecars__card' )
					.getAttribute( 'aria-label' )
			).toBe( 'n1:seen:offsetlog (Partition)' );
			expect( outer.contains( inner ) ).toBe( true );
			const [ , x, y ] = /translate\(([-\d.]+),([-\d.]+)\)/
				.exec(
					outer
						.querySelectorAll( '.topology-sidecars__card' )[ 1 ]
						.querySelector( '.topology-node' )
						.getAttribute( 'transform' )
				)
				.map( Number );
			expect(
				inner
					.querySelector( '.topology-sidecars__frame' )
					.getAttribute( 'd' )
			).toContain( ` L ${ x + NODE_W / 2 },${ y + CARD_H } L ` );
			expect( document.activeElement ).toBe(
				inner.querySelector( '.topology-sidecars__card' )
			);
			expect( sent[ sent.length - 1 ][ VALUE ].arguments ).toEqual( [
				'-o',
				'n1',
				'n1:seen',
			] );
			expect( inspectorText( getByTestId ) ).toBe(
				'insp:remove-selectedopen-owneropen-seenverb'
			);
		} );

		it( 'shows a pick from the inner grid and keeps both open, asking for every owner and the shown', async () => {
			const { getByTestId } = await openNested();
			const [ , inner ] = popovers();
			const picked = inner.querySelector( '.topology-sidecars__card' );
			picked.focus();
			fireEvent.click( picked );
			await flush();
			expect( inspectorText( getByTestId ) ).toContain(
				'insp:n1/sidecar:n1:seen:offsetlog'
			);
			expect( popovers() ).toHaveLength( 2 );
			expect( document.activeElement ).toBe( picked );
			expect( sent[ sent.length - 1 ][ VALUE ].arguments ).toEqual( [
				'-o',
				'n1:seen:offsetlog',
				'n1',
				'n1:seen',
			] );
		} );

		it( 'closes the innermost on Esc, focus back on its "…", then the next', async () => {
			await openNested();
			const dots = popovers()[ 0 ].querySelector(
				'.topology-node__sidecars'
			);
			fireEvent.keyDown( document, { key: 'Escape' } );
			await flush();
			expect( popovers() ).toHaveLength( 1 );
			expect( document.activeElement ).toBe( dots );
			fireEvent.keyDown( document, { key: 'Escape' } );
			await flush();
			expect( popovers() ).toHaveLength( 0 );
		} );

		it.each( [
			[ "another card's selection", ( c ) => c.onSelect( 'n2' ) ],
			[ 'a background click', ( c ) => c.onDeselect() ],
			[ 'an edge', ( c ) => c.onSelectEdge( { from: 'a', to: 'b' } ) ],
			[ 'a hull', ( c ) => c.onSelectHull( 'quokka.tsl' ) ],
		] )( 'closes every grid on %s', async ( _, select ) => {
			await openNested();
			act( () => select( global.__canvasProps ) );
			await flush();
			expect( popovers() ).toHaveLength( 0 );
		} );

		it( 'leaves a click inside the canvas to the canvas', async () => {
			await openNested();
			fireEvent.click(
				popovers()[ 1 ].querySelector( '.topology-sidecars__frame' )
			);
			await flush();
			expect( popovers() ).toHaveLength( 2 );
		} );

		it( 'keeps every grid through an Inspector click while it shows a picked sidecar', async () => {
			const { getByText, getByTestId } = await openNested();
			fireEvent.click(
				popovers()[ 1 ].querySelector( '.topology-sidecars__card' )
			);
			await flush();
			press( getByText( 'verb' ) );
			await flush();
			expect( popovers() ).toHaveLength( 2 );
			expect( inspectorText( getByTestId ) ).toContain(
				'/sidecar:n1:seen:offsetlog'
			);
		} );

		it( 'closes every grid on an Inspector click while it shows no picked sidecar', async () => {
			const { getByText } = await openNested();
			press( getByText( 'verb' ) );
			await flush();
			expect( popovers() ).toHaveLength( 0 );
		} );

		it( 'closes every grid on a click off the canvas, such as the Palette', async () => {
			const { getByTestId } = await openNested( { showPalette: true } );
			fireEvent.click(
				popovers()[ 1 ].querySelector( '.topology-sidecars__card' )
			);
			await flush();
			press( getByTestId( 'palette' ) );
			await flush();
			expect( popovers() ).toHaveLength( 0 );
		} );

		it( 'hands the canvas one overlay across a render that changes nothing it draws', async () => {
			const { rerender } = await openNested();
			const overlay = global.__canvasProps.overlay;
			rerender(
				<GraphView graph={ owned } frame={ Frame } resetKey="k" />
			);
			expect( global.__canvasProps.overlay ).toBe( overlay );
		} );

		/**
		 * Stand a dialog on the page as ModalShell portals one, holding a button.
		 *
		 * @return {HTMLButtonElement} Its button.
		 */
		const portalDialog = () => {
			const dialog = document.createElement( 'div' );
			dialog.className = 'topology-modal newspack-nodes-modal';
			dialog.setAttribute( 'role', 'dialog' );
			const button = document.createElement( 'button' );
			button.textContent = 'run verb';
			dialog.appendChild( button );
			document.body.appendChild( dialog );
			return button;
		};

		afterEach( () =>
			document.body
				.querySelectorAll( '.topology-modal' )
				.forEach( ( el ) => el.remove() )
		);

		it( 'keeps every grid through a click in an Inspector dialog while it shows a picked sidecar', async () => {
			await openNested();
			fireEvent.click(
				popovers()[ 1 ].querySelector( '.topology-sidecars__card' )
			);
			await flush();
			press( portalDialog() );
			await flush();
			expect( popovers() ).toHaveLength( 2 );
		} );

		it( 'closes every grid on a click in a dialog while it shows no picked sidecar', async () => {
			await openNested();
			press( portalDialog() );
			await flush();
			expect( popovers() ).toHaveLength( 0 );
		} );

		it( 'drops a grid its parent no longer lists, so one Esc closes the grid on screen', async () => {
			await openNested();
			answer( {
				n1: {
					class: 'Crawler',
					sidecars: [ { name: 'n1:curl', class: 'Curl' } ],
				},
				'n1:curl': { class: 'Curl', counter: 41 },
			} );
			await flush();
			expect( popovers() ).toHaveLength( 1 );
			fireEvent.keyDown( document, { key: 'Escape' } );
			await flush();
			expect( popovers() ).toHaveLength( 0 );
		} );

		it( 'closes a grid whose owner lists no sidecars, for good', async () => {
			await openNested();
			answer( { n1: { class: 'Crawler', counter: 70 } } );
			await flush();
			expect( popovers() ).toHaveLength( 0 );
			expect( Core.node( SIDECAR_POLLER ) ).toBeFalsy();
		} );

		it( 'refocuses the "…" of an owner whose name a selector must escape', async () => {
			const odd = 'n1:say "hi" \\ 4u';
			const oddGraph = {
				nodes: [
					{
						id: 'n1',
						count: 0,
						sidecars: [ { name: odd, class: 'Table' } ],
					},
				],
				edges: [],
			};
			const { getByText } = renderWithCatalog(
				<GraphView graph={ oddGraph } frame={ Frame } resetKey="k" />
			);
			fireEvent.click( getByText( 'sidecars-n1' ) );
			await flush();
			answer( {
				n1: {
					class: 'Crawler',
					sidecars: oddGraph.nodes[ 0 ].sidecars,
				},
				[ odd ]: {
					class: 'Table',
					counter: 3,
					sidecars: [ { name: `${ odd }:log`, class: 'Log' } ],
				},
			} );
			const dots = popovers()[ 0 ].querySelector(
				'.topology-node__sidecars'
			);
			fireEvent.click( dots );
			await flush();
			expect( popovers() ).toHaveLength( 2 );
			fireEvent.keyDown( document, { key: 'Escape' } );
			await flush();
			expect( popovers() ).toHaveLength( 1 );
			expect( document.activeElement ).toBe( dots );
		} );

		it( 'closes a grid on its own "…" again', async () => {
			const { getByText } = await openNested();
			fireEvent.click(
				popovers()[ 0 ].querySelector( '.topology-node__sidecars' )
			);
			await flush();
			expect( popovers() ).toHaveLength( 1 );
			fireEvent.click( getByText( 'sidecars-n1' ) );
			await flush();
			expect( popovers() ).toHaveLength( 0 );
		} );

		it( "asks for 256 sidecars by their owner's name, under every size cap", async () => {
			const readers = Array.from( { length: 256 }, ( _, i ) => ( {
				name: `n1:logs/xyz-${ String( 1000 + i ) }.p0`,
				class: 'Remote_Consumer',
			} ) );
			const broker = {
				nodes: [ { id: 'n1', count: 0, sidecars: readers } ],
				edges: [],
			};
			const { getByText } = renderWithCatalog(
				<GraphView graph={ broker } frame={ Frame } resetKey="k" />
			);
			fireEvent.click( getByText( 'sidecars-n1' ) );
			await act( async () => {} );
			const ask = sent[ sent.length - 1 ];
			expect( ask[ FROM ].length ).toBeLessThanOrEqual( MAX_FROM_SIZE );
			expect( pack( ask ).length ).toBeLessThan( 4096 );
			answer(
				Object.fromEntries( [
					[ 'n1', { class: 'Remote_Source', sidecars: readers } ],
					...readers.map( ( r, i ) => [
						r.name,
						{ class: 'Remote_Consumer', counter: 5000 + i },
					] ),
				] )
			);
			expect(
				document.body.querySelectorAll( '.topology-sidecars__card' )
			).toHaveLength( 256 );
			expect(
				readout( 255 ).querySelector( '.topology-node__counter' )
					.textContent
			).toBe( '5,255' );
		} );

		it( "draws a sidecar the owner's answer lists after the grid opened", async () => {
			const { getByText } = renderWithCatalog(
				<GraphView graph={ owned } frame={ Frame } resetKey="k" />
			);
			fireEvent.click( getByText( 'sidecars-n1' ) );
			await act( async () => {} );
			const claimed = {
				name: 'n1:logs/new-7741.p0',
				class: 'Remote_Consumer',
			};
			answer( {
				n1: {
					class: 'Crawler',
					sidecars: [ ...owned.nodes[ 0 ].sidecars, claimed ],
				},
				[ claimed.name ]: { class: 'Remote_Consumer', counter: 77 },
			} );
			expect( card( 2 ).getAttribute( 'aria-label' ) ).toBe(
				'n1:logs/new-7741.p0 (Remote_Consumer)'
			);
			expect(
				readout( 2 ).querySelector( '.topology-node__counter' )
					.textContent
			).toBe( '77' );
		} );

		it( "feeds the shown sidecar's Inspector, asking for it beside the open grid, then alone", async () => {
			await pick( 'n1:seen' );
			await act( async () => {} );
			expect( sent[ sent.length - 1 ][ VALUE ].arguments ).toEqual( [
				'-o',
				'n1:seen',
				'n1',
			] );
			answer( { 'n1:seen': { class: 'Table', counter: 3301 } } );
			expect(
				global.__inspectorProps.sidecarGraph.nodes[ 0 ]
			).toMatchObject( { id: 'n1:seen', count: 3301 } );
			fireEvent.keyDown( document, { key: 'Escape' } );
			await act( async () => {} );
			expect( sent[ sent.length - 1 ][ VALUE ].arguments ).toEqual( [
				'-o',
				'n1:seen',
			] );
		} );
	} );

	it( 'choosing a card selects its owner, shows the sidecar and keeps the grid open on it', async () => {
		const onSelectionChange = jest.fn();
		const { getByText, getByTestId } = renderWithCatalog(
			<GraphView
				graph={ owned }
				frame={ Frame }
				resetKey="k"
				onSelectionChange={ onSelectionChange }
			/>
		);
		fireEvent.click( getByText( 'sidecars-n1' ) );
		await flush();
		const pressed = document.body.querySelectorAll(
			'.topology-sidecars__card'
		)[ 1 ];
		pressed.focus();
		fireEvent.click( pressed );
		await flush();
		expect( inspectorText( getByTestId ) ).toContain(
			'insp:n1/sidecar:n1:seen'
		);
		expect( onSelectionChange ).toHaveBeenCalledWith( 'n1' );
		const cards = [
			...document.body.querySelectorAll( '.topology-sidecars__card' ),
		];
		expect( cards ).toHaveLength( 2 );
		expect( document.activeElement ).toBe( cards[ 1 ] );
		expect( cards[ 1 ].getAttribute( 'aria-current' ) ).toBe( 'true' );
		expect(
			cards[ 1 ]
				.querySelector( '.topology-node' )
				.classList.contains( 'is-selected' )
		).toBe( true );
		expect( global.__inspectorProps.onOpenSidecars ).toBeUndefined();
	} );

	it( "hangs the grid below its owner's card on the canvas", async () => {
		const { getByText } = renderWithCatalog(
			<GraphView graph={ owned } frame={ Frame } resetKey="k" />
		);
		fireEvent.click( getByText( 'sidecars-n1' ) );
		await flush();
		const grid = document.body.querySelector( '[role="dialog"]' );
		expect(
			grid.ownerSVGElement.closest( '[data-testid="canvas"]' )
		).not.toBe( null );
		expect(
			grid
				.querySelector( '.topology-sidecars__frame' )
				.getAttribute( 'd' )
		).toContain(
			` L ${ CANVAS_AT.n1.x + NODE_W / 2 },${
				CANVAS_AT.n1.y + CARD_H
			} L `
		);
	} );

	it( 'closes the grid, and its poll, once its owner leaves the graph', async () => {
		const { getByText, rerender } = renderWithCatalog(
			<GraphView graph={ owned } frame={ Frame } resetKey="k" />
		);
		fireEvent.click( getByText( 'sidecars-n1' ) );
		await flush();
		expect( document.body.querySelector( '[role="dialog"]' ) ).not.toBe(
			null
		);
		rerender(
			<GraphView
				graph={ { nodes: [ owned.nodes[ 1 ] ], edges: [] } }
				frame={ Frame }
				resetKey="k"
			/>
		);
		await flush();
		expect( document.body.querySelector( '[role="dialog"]' ) ).toBe( null );
		expect( Core.node( SIDECAR_POLLER ) ).toBeFalsy();
		rerender( <GraphView graph={ owned } frame={ Frame } resetKey="k" /> );
		await flush();
		expect( document.body.querySelector( '[role="dialog"]' ) ).toBe( null );
	} );

	it( 'dismissing the list on Esc returns focus to its trigger', async () => {
		const { getByTestId } = renderWithCatalog(
			<GraphView graph={ owned } frame={ Frame } resetKey="k" />
		);
		const trigger = getByTestId( 'sidecars-n1' );
		fireEvent.click( trigger );
		await flush();
		fireEvent.keyDown( document, { key: 'Escape' } );
		await flush();
		expect(
			document.body.querySelector( '.topology-sidecars__card' )
		).toBe( null );
		expect( document.activeElement ).toBe( trigger );
	} );

	it( "keeps the grid through a pick after the canvas redraws its owner's \u201c\u2026\u201d, and Esc focuses the new one", async () => {
		const { getByText, getByTestId, rerender } = renderWithCatalog(
			<GraphView graph={ owned } frame={ Frame } resetKey="k" />
		);
		fireEvent.click( getByText( 'sidecars-n1' ) );
		await flush();
		const first = getByTestId( 'sidecars-n1' );
		global.__dotsGeneration = 7;
		rerender( <GraphView graph={ owned } frame={ Frame } resetKey="k" /> );
		const redrawn = getByTestId( 'sidecars-n1' );
		expect( redrawn ).not.toBe( first );
		fireEvent.click(
			document.body.querySelectorAll( '.topology-sidecars__card' )[ 1 ]
		);
		await flush();
		expect(
			document.body.querySelectorAll( '[role="dialog"]' )
		).toHaveLength( 1 );
		fireEvent.keyDown( document, { key: 'Escape' } );
		await flush();
		expect( document.body.querySelector( '[role="dialog"]' ) ).toBeNull();
		expect( document.activeElement ).toBe( redrawn );
	} );

	it( "focuses the canvas on Esc when the owner's \u201c\u2026\u201d is not drawn", async () => {
		const { getByText, getByTestId, rerender } = renderWithCatalog(
			<GraphView graph={ owned } frame={ Frame } resetKey="k" />
		);
		fireEvent.click( getByText( 'sidecars-n1' ) );
		await flush();
		global.__dotsHidden = true;
		rerender( <GraphView graph={ owned } frame={ Frame } resetKey="k" /> );
		fireEvent.keyDown( document, { key: 'Escape' } );
		await flush();
		expect( document.body.querySelector( '[role="dialog"]' ) ).toBeNull();
		expect( document.activeElement ).toBe( getByTestId( 'canvas-svg' ) );
	} );

	/** The open grids, outermost first. */
	const grids = () => [
		...document.body.querySelectorAll( '.topology-sidecars' ),
	];

	/**
	 * Open n1's grid on a fresh GraphView.
	 *
	 * @param {Object} [props] Extra GraphView props.
	 * @return {Promise<Object>} What renderWithCatalog returns.
	 */
	const openGrid = async ( props = {} ) => {
		const rendered = renderWithCatalog(
			<GraphView
				graph={ owned }
				frame={ Frame }
				resetKey="k"
				{ ...props }
			/>
		);
		fireEvent.click( rendered.getByText( 'sidecars-n1' ) );
		await flush();
		return rendered;
	};

	it( 'leaves every grid to a dialog open elsewhere on Esc, wherever focus is', async () => {
		await openGrid();
		const onDismiss = jest.fn();
		render(
			<ModalShell title="Runtime" onDismiss={ onDismiss }>
				<p>rows</p>
			</ModalShell>
		);
		const card = document.activeElement;
		expect( card.classList.contains( 'topology-sidecars__card' ) ).toBe(
			true
		);
		fireEvent.keyDown( card, { key: 'Escape' } );
		await flush();
		expect( onDismiss ).toHaveBeenCalledTimes( 1 );
		expect( grids() ).toHaveLength( 1 );
	} );

	it( 'leaves the grid to a dialog that takes the Esc, closing only the dialog', async () => {
		await openGrid();
		render( <OwnDialog /> );
		const card = document.activeElement;
		expect( card.classList.contains( 'topology-sidecars__card' ) ).toBe(
			true
		);
		fireEvent.keyDown( card, { key: 'Escape' } );
		await flush();
		expect( document.body.querySelector( '.topology-modal' ) ).toBeNull();
		expect( grids() ).toHaveLength( 1 );
	} );

	it( 'closes the innermost grid on Esc beside a hidden modal dialog', async () => {
		await openGrid();
		const hidden = document.createElement( 'div' );
		hidden.id = 'wp-link-wrap';
		hidden.style.display = 'none';
		hidden.setAttribute( 'role', 'dialog' );
		hidden.setAttribute( 'aria-modal', 'true' );
		document.body.appendChild( hidden );
		fireEvent.keyDown( document, { key: 'Escape' } );
		await flush();
		hidden.remove();
		expect( grids() ).toHaveLength( 0 );
	} );

	it( 'leaves the grids to an Esc a handler already took', async () => {
		await openGrid();
		const take = ( e ) => 'Escape' === e.key && e.preventDefault();
		document.addEventListener( 'keydown', take );
		fireEvent.keyDown( document.activeElement, { key: 'Escape' } );
		await flush();
		document.removeEventListener( 'keydown', take );
		expect( grids() ).toHaveLength( 1 );
	} );

	it( "keeps every grid through a press on an Inspector dialog's backdrop that dismisses it", async () => {
		await openGrid();
		fireEvent.click(
			document.body.querySelectorAll( '.topology-sidecars__card' )[ 1 ]
		);
		await flush();
		render( <OwnDialog /> );
		fireEvent.mouseDown(
			document.body.querySelector( '.topology-modal-backdrop' )
		);
		expect( document.body.querySelector( '.topology-modal' ) ).toBeNull();
		fireEvent.mouseUp( document.body );
		fireEvent.click( document.body );
		await flush();
		expect( grids() ).toHaveLength( 1 );
	} );

	it( 'rebuilds no grid for a canvas poll once the owner row is polled', async () => {
		const { rerender } = await openGrid();
		act( () =>
			Core.node( SIDECAR_POLLER ).fill(
				( () => {
					const reply = newMessage();
					reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
					reply[ TO ] = encodeURIComponent(
						Core.node( SIDECAR_POLLER ).subject
					);
					reply[ VALUE ] = {
						payload: {
							n1: {
								class: 'Crawler',
								sidecars: owned.nodes[ 0 ].sidecars,
							},
						},
					};
					return reply;
				} )()
			)
		);
		await flush();
		const overlay = global.__canvasProps.overlay;
		rerender(
			<GraphView
				graph={ {
					nodes: owned.nodes.map( ( n ) => ( { ...n, count: 9 } ) ),
					edges: [],
				} }
				frame={ Frame }
				resetKey="k"
			/>
		);
		expect( global.__canvasProps.overlay ).toBe( overlay );
	} );

	it( 'closes every grid when the consumer selects another node', async () => {
		const onSelectionChange = jest.fn();
		const { rerender } = await openGrid( { onSelectionChange } );
		fireEvent.click(
			document.body.querySelectorAll( '.topology-sidecars__card' )[ 1 ]
		);
		await flush();
		expect( onSelectionChange ).toHaveBeenLastCalledWith( 'n1' );
		const at = ( selection ) =>
			rerender(
				<GraphView
					graph={ owned }
					frame={ Frame }
					resetKey="k"
					selection={ selection }
					onSelectionChange={ onSelectionChange }
				/>
			);
		at( 'n1' );
		await flush();
		expect( grids() ).toHaveLength( 1 );
		at( 'n2' );
		await flush();
		expect( grids() ).toHaveLength( 0 );
	} );

	it( 'renders once to close the last grid on Esc, writing nothing back', async () => {
		await openGrid();
		global.__inspectorRenders = [];
		fireEvent.keyDown( document, { key: 'Escape' } );
		await flush();
		expect( grids() ).toHaveLength( 0 );
		expect( global.__inspectorRenders ).toHaveLength( 1 );
	} );

	it( 'renders once to close the last grid from its own "…", writing nothing back', async () => {
		const { getByText } = await openGrid();
		global.__inspectorRenders = [];
		fireEvent.click( getByText( 'sidecars-n1' ) );
		await flush();
		expect( grids() ).toHaveLength( 0 );
		expect( global.__inspectorRenders ).toHaveLength( 1 );
	} );

	it( 'closes every grid when the scope changes', async () => {
		const { getByText, rerender } = renderWithCatalog(
			<GraphView graph={ owned } frame={ Frame } resetKey="k" />
		);
		fireEvent.click( getByText( 'sidecars-n1' ) );
		await flush();
		rerender(
			<GraphView graph={ owned } frame={ Frame } resetKey="worker-p3" />
		);
		await flush();
		rerender( <GraphView graph={ owned } frame={ Frame } resetKey="k" /> );
		await flush();
		expect( document.body.querySelector( '[role="dialog"]' ) ).toBeNull();
	} );

	it( 'blooms its cards only while the canvas draws detail', async () => {
		const { getByText, rerender } = renderWithCatalog(
			<GraphView graph={ owned } frame={ Frame } resetKey="k" />
		);
		fireEvent.click( getByText( 'sidecars-n1' ) );
		await flush();
		const bloom = () =>
			document.body.querySelector(
				'[role="dialog"] .topology-nodes--bloom'
			);
		expect( bloom() ).not.toBeNull();
		global.__lod = true;
		rerender( <GraphView graph={ owned } frame={ Frame } resetKey="k" /> );
		expect( document.body.querySelector( '[role="dialog"]' ) ).not.toBe(
			null
		);
		expect( bloom() ).toBeNull();
	} );

	it( "removes nothing on Delete or Backspace from a dialog's focused button", async () => {
		const onRemoveNode = jest.fn();
		const { getByText } = renderWithCatalog(
			<GraphView
				graph={ owned }
				frame={ Frame }
				resetKey="k"
				onRemoveNode={ onRemoveNode }
			/>
		);
		fireEvent.click( getByText( 'select-n2' ) );
		render(
			<ConfirmModal
				title="Discard the draft?"
				body="It has unsaved lines."
				onConfirm={ () => {} }
				onCancel={ () => {} }
			/>
		);
		const focused = document.activeElement;
		expect( focused.closest( '[role="dialog"]' ) ).not.toBeNull();
		fireEvent.keyDown( focused, { key: 'Delete' } );
		fireEvent.keyDown( focused, { key: 'Backspace' } );
		expect( onRemoveNode ).not.toHaveBeenCalled();
		fireEvent.keyDown( document.body, { key: 'Delete' } );
		expect( onRemoveNode ).toHaveBeenCalledWith( 'n2' );
	} );

	it( 'removes nothing on Backspace from a grid card with its owner selected', async () => {
		const onRemoveNode = jest.fn();
		const { getByText } = renderWithCatalog(
			<GraphView
				graph={ owned }
				frame={ Frame }
				resetKey="k"
				onRemoveNode={ onRemoveNode }
			/>
		);
		fireEvent.click( getByText( 'select-n1' ) );
		fireEvent.click( getByText( 'sidecars-n1' ) );
		await flush();
		const card = document.body.querySelector( '.topology-sidecars__card' );
		expect( document.activeElement ).toBe( card );
		fireEvent.keyDown( card, { key: 'Backspace' } );
		fireEvent.keyDown( card, { key: 'Delete' } );
		expect( onRemoveNode ).not.toHaveBeenCalled();
	} );

	it( 'Delete while a sidecar is shown removes nothing', async () => {
		const onRemoveNode = jest.fn();
		await pick( 'n1:seen', { onRemoveNode } );
		fireEvent.keyDown( document, { key: 'Delete' } );
		expect( onRemoveNode ).not.toHaveBeenCalled();
	} );

	it( 'returning to the owner after another selection shows the owner, not the sidecar', async () => {
		const { getByText, getByTestId } = await pick( 'n1:seen' );
		fireEvent.click( getByText( 'select-n2' ) );
		fireEvent.click( getByText( 'select-n1' ) );
		await flush();
		expect( inspectorText( getByTestId ) ).not.toContain( 'sidecar:' );
	} );

	it( 'drops the sidecar when edit mode comes and goes', async () => {
		const { getByTestId, rerender } = await pick( 'n1:seen' );
		rerender(
			<GraphView graph={ owned } frame={ Frame } resetKey="k" editMode />
		);
		rerender( <GraphView graph={ owned } frame={ Frame } resetKey="k" /> );
		expect( inspectorText( getByTestId ) ).not.toContain( 'sidecar:' );
	} );

	it( 'stops showing the sidecar once its owner leaves the graph', async () => {
		const { getByTestId, rerender } = await pick( 'n1:seen' );
		rerender(
			<GraphView
				graph={ { nodes: [ owned.nodes[ 1 ] ], edges: [] } }
				frame={ Frame }
				resetKey="k"
			/>
		);
		expect( inspectorText( getByTestId ) ).not.toContain( 'sidecar:' );
	} );

	it( "the owner link returns to the canvas owner's Inspector", async () => {
		const { getByText, getByTestId } = await pick( 'n1:seen' );
		fireEvent.click( getByText( 'open-owner' ) );
		await flush();
		expect( inspectorText( getByTestId ) ).toContain( 'insp:n1' );
		expect( inspectorText( getByTestId ) ).not.toContain( 'sidecar:' );
	} );
} );
