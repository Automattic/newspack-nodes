import { render, fireEvent, act } from '@testing-library/react';
import GraphView from '../GraphView';

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
	global.__inspectorProps = props;
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
	global.__paletteProps = props;
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

describe( 'GraphView', () => {
	it( 'renders the canvas and forwards a connect gesture to onConnect', () => {
		const onConnect = jest.fn();
		const { getByText } = render(
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
		const { getByTestId, getByText } = render(
			<GraphView graph={ graph } frame={ Frame } resetKey="k" />
		);
		// Default-expanded: the Inspector renders before any selection.
		expect( getByTestId( 'inspector' ) ).not.toBeNull();
		expect( getByTestId( 'inspector' ).textContent ).not.toContain( 'n1' );
		fireEvent.click( getByText( 'select-n1' ) );
		expect( getByTestId( 'inspector' ).textContent ).toContain( 'n1' );
	} );

	it( 'forwards composeTargets through to Inspector', () => {
		const composeTargets = [ '_command_interpreter', 'n1', 'n1:config' ];
		render(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				composeTargets={ composeTargets }
			/>
		);
		expect( global.__inspectorProps.composeTargets ).toBe( composeTargets );
	} );

	it( 'renders the palette only when showPalette is set', () => {
		const { queryByTestId, rerender } = render(
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
		const { getByText, getByTestId, rerender } = render(
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
		const { getByText } = render(
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
		const { getByText } = render(
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
		const { getByText, rerender } = render(
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
		render(
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
		render(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				showPalette
				catalog={ [ { shell_name: 'Echo' } ] }
				paletteLoading
			/>
		);
		expect( global.__paletteProps.loading ).toBe( true );
	} );

	it( 'Delete key on a selected node calls onRemoveNode', () => {
		const onRemoveNode = jest.fn();
		const { getByText } = render(
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
		const { getByText } = render(
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
		render(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				hulls={ hulls }
			/>
		);
		expect( global.__canvasProps.hulls ).toBe( hulls );
	} );

	it( 'forwards ONE `includes` prop to both Palette (declaredIncludes) and Inspector (includes)', () => {
		const topologies = [ { name: 'performance', includes: [] } ];
		const onDropTopology = jest.fn();
		const includeTree = { performance: {} };
		const onRemoveInclude = jest.fn();
		render(
			<GraphView
				graph={ graph }
				frame={ Frame }
				resetKey="k"
				showPalette
				topologies={ topologies }
				currentTopology="wombat-top"
				includes={ [ 'performance' ] }
				onDropTopology={ onDropTopology }
				includeTree={ includeTree }
				onRemoveInclude={ onRemoveInclude }
			/>
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
		const { getByTestId, getByLabelText, queryByTestId, rerender } = render(
			<GraphView
				graph={ twoNodeGraph }
				frame={ Frame }
				selection="n2"
				inspectorCollapsed={ false }
				onInspectorToggle={ onInspectorToggle }
			/>
		);
		expect( getByTestId( 'inspector' ) ).not.toBeNull();
		fireEvent.click( getByLabelText( 'Collapse inspector' ) );
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
		expect( getByLabelText( 'Expand inspector' ) ).not.toBeNull();
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
		const { rerender } = render(
			<GraphView graph={ g0 } frame={ Frame } resetKey="k" />
		);
		// A second poll (new graph identity) accumulates one In-rate sample.
		rerender( <GraphView graph={ g1 } frame={ Frame } resetKey="k" /> );
		const len = global.__inspectorProps.rateSeries.in.length;
		expect( len ).toBeGreaterThan( 0 );
		// Collapse→expand (same graph) keeps the GraphView-held series intact.
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

describe( 'GraphView — hull selection', () => {
	it( 'clicking the background clears a selected HULL, not just a node', () => {
		const hulls = [ { include: 'performance', nodeIds: [ 'n1' ] } ];
		const { getByText } = render(
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
			const { rerender } = render(
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

	it( 'shows the history recorded BEFORE the hull was selected', () => {
		withClock( ( tick ) => {
			// Three polls with NO hull selected. useGraphRates is recording the
			// whole time, so selecting the hull afterwards must reveal that
			// history — not start a fresh accumulation from zero.
			const { rerender } = render(
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
