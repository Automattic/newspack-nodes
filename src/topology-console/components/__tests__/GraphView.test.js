import { fireEvent, act } from '@testing-library/react';
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
import { MAX_FROM_SIZE } from '../../../runtime/node';
import names from '../../../runtime/reserved-node-names.json';

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
			<button onClick={ () => props.onSelectHull( 'quokka.tsl' ) }>
				select-hull
			</button>
			<button
				onClick={ ( ev ) =>
					props.onOpenSidecars( 'n1', ev.currentTarget )
				}
			>
				sidecars-n1
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
			<button
				onClick={ ( ev ) =>
					props.onOpenSidecars?.( 'n1:seen', ev.currentTarget )
				}
			>
				nested-sidecars
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
			'insp:remove-selectedopen-owneropen-seennested-sidecars'
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
			fireEvent.click(
				document.body.querySelector( '.topology-modal__close' )
			);
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
				card( 1 ).querySelector( '.topology-node__counter' ).textContent
			).toBe( '6,100' );
			expect(
				card( 1 ).querySelector( '.topology-node__rate' ).textContent
			).toBe( '' );
			now += 2000;
			answer( { 'n1:seen': { class: 'Table', counter: 6142 } } );
			expect(
				card( 1 ).querySelector( '.topology-node__rate' ).textContent
			).toBe( '21.0 /s' );
			now += 1000;
			answer( { 'n1:seen': { class: 'Table', counter: 6172 } } );
			expect(
				card( 1 ).querySelector( '.topology-node__counter' ).textContent
			).toBe( '6,172' );
			expect(
				card( 1 ).querySelector( '.topology-node__spark' )
			).not.toBeNull();
			expect(
				card( 0 ).querySelector( '.topology-node__counter' ).textContent
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
				card( 1 ).querySelector( '.topology-node__rate' ).textContent
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

		/** `n1:seen` answered owning `n1:seen:offsetlog`, both with rows. */
		const answerSeen = () =>
			answer( {
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

		it( "a sidecar's own sidecar opens from its Inspector, its owner's row dropped", async () => {
			const { getByText, getByTestId } = await pick( 'n1:seen' );
			answerSeen();
			fireEvent.click( getByText( 'nested-sidecars' ) );
			await flush();
			expect( card( 0 ).getAttribute( 'aria-label' ) ).toBe(
				'n1:seen:offsetlog (Partition)'
			);
			fireEvent.click( card( 0 ) );
			await flush();
			expect( inspectorText( getByTestId ) ).toContain(
				'insp:n1/sidecar:n1:seen:offsetlog'
			);
			expect(
				global.__inspectorProps.sidecarGraph.nodes.map( ( n ) => n.id )
			).toEqual( [ 'n1:seen:offsetlog' ] );
			fireEvent.click( getByText( 'open-seen' ) );
			await flush();
			expect( inspectorText( getByTestId ) ).toContain(
				'insp:n1/sidecar:n1:seen'
			);
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
				card( 255 ).querySelector( '.topology-node__counter' )
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
				card( 2 ).querySelector( '.topology-node__counter' ).textContent
			).toBe( '77' );
		} );

		it( "feeds the shown sidecar's Inspector, and asks for it beside an open grid", async () => {
			const { getByText } = await pick( 'n1:seen' );
			await act( async () => {} );
			expect( sent[ sent.length - 1 ][ VALUE ].arguments ).toEqual( [
				'-o',
				'n1:seen',
			] );
			answer( { 'n1:seen': { class: 'Table', counter: 3301 } } );
			expect(
				global.__inspectorProps.sidecarGraph.nodes[ 0 ]
			).toMatchObject( { id: 'n1:seen', count: 3301 } );
			fireEvent.click( getByText( 'sidecars-n1' ) );
			await act( async () => {} );
			expect( sent[ sent.length - 1 ][ VALUE ].arguments ).toEqual( [
				'-o',
				'n1:seen',
				'n1',
			] );
		} );
	} );

	it( 'choosing a card selects its owner, shows the sidecar and focuses the Inspector', async () => {
		const onSelectionChange = jest.fn();
		const { getByTestId, container } = await pick( 'n1:seen', {
			onSelectionChange,
		} );
		expect( inspectorText( getByTestId ) ).toContain(
			'insp:n1/sidecar:n1:seen'
		);
		expect( onSelectionChange ).toHaveBeenCalledWith( 'n1' );
		expect(
			document.body.querySelector( '.topology-sidecars__card' )
		).toBe( null );
		expect( document.activeElement ).toBe(
			container.querySelector( '.topology-inspector-dock' )
		);
	} );

	it( 'dismissing the list returns focus to its trigger', async () => {
		const { getByText } = renderWithCatalog(
			<GraphView graph={ owned } frame={ Frame } resetKey="k" />
		);
		const trigger = getByText( 'sidecars-n1' );
		fireEvent.click( trigger );
		fireEvent.click(
			document.body.querySelector( '.topology-modal__close' )
		);
		expect(
			document.body.querySelector( '.topology-sidecars__card' )
		).toBe( null );
		expect( document.activeElement ).toBe( trigger );
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
		expect( inspectorText( getByTestId ) ).toContain( 'insp:n1' );
		expect( inspectorText( getByTestId ) ).not.toContain( 'sidecar:' );
	} );
} );
