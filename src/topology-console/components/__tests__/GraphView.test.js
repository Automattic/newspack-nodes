import { fireEvent, act } from '@testing-library/react';
import GraphView from '../GraphView';
import { renderWithCatalog } from '../../__tests__/catalogTestUtils';

// Minimal frame stub: renders children (the console passes CanvasFrame).
const Frame = ( { children } ) => <div data-testid="frame">{ children }</div>;

// Stub the leaf components so we assert wiring, not their internals.
jest.mock( '../SchematicCanvas', () => ( props ) => {
	global.__canvasProps = props;
	return (
		<div data-testid="canvas">
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
		</div>
	);
} );
jest.mock( '../Inspector', () => ( props ) => {
	const { useCatalog } = require( '../../CatalogContext' );
	global.__inspectorProps = { ...props, ...useCatalog() };
	return (
		<div data-testid="inspector">
			insp:{ props.selectedId }
			<button onClick={ () => props.onRemoveNode( props.selectedId ) }>
				remove-selected
			</button>
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

	it( 'external null-clear also clears a selected edge', () => {
		const onRemoveEdge = jest.fn();
		// Self-controlled; selection→null forces re-sync (bug: edge stale).
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
		expect( onRemoveEdge ).not.toHaveBeenCalled();
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
			const { rerender } = renderWithCatalog(
				<GraphView graph={ g0 } frame={ Frame } resetKey="k" />
			);
			// A second poll, one second on, accumulates one In-rate sample.
			tick();
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

	it( 'scopes the hull rate series to the hull MEMBERS, not the whole graph', () => {
		withClock( ( tick ) => {
			// Both are sources, so both feed the graph-wide In rate; only `inside`
			// is a member. The deltas differ by an order of magnitude, so a series
			// built from the wrong scope can't coincidentally match the right one.
			const { rerender } = renderWithCatalog(
				hullView( hullNodesGraph( 10, 100 ) )
			);
			act( () => {
				global.__canvasProps.onSelectHull( 'performance' );
			} );
			// A second poll, one second on: `inside` +30/s, `outside` +400/s.
			tick();
			rerender( hullView( hullNodesGraph( 40, 500 ) ) );

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
			const { rerender } = renderWithCatalog(
				hullView( hullNodesGraph( 10, 100 ) )
			);
			tick();
			rerender( hullView( hullNodesGraph( 40, 500 ) ) );
			tick();
			// `inside` respawned to 0; `outside` kept climbing by 400/s.
			rerender( hullView( hullNodesGraph( 0, 900 ) ) );

			const graphIn = global.__inspectorProps.rateSeries.in;
			expect( graphIn[ graphIn.length - 1 ] ).toBe( 400 );
		} );
	} );

	it( 'shows the history recorded BEFORE the hull was selected', () => {
		withClock( ( tick ) => {
			// Three polls with NO hull selected. useGraphRates is recording the
			// whole time, so selecting the hull afterwards must reveal that
			// history — not start a fresh accumulation from zero.
			const { rerender } = renderWithCatalog(
				hullView( hullNodesGraph( 10, 100 ) )
			);
			tick();
			rerender( hullView( hullNodesGraph( 40, 500 ) ) );
			tick();
			rerender( hullView( hullNodesGraph( 90, 900 ) ) );

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
