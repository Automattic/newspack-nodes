import { render, fireEvent } from '@testing-library/react';
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

	it( 'shows the inspector only after a node is selected', () => {
		const { queryByTestId, getByText } = render(
			<GraphView graph={ graph } frame={ Frame } resetKey="k" />
		);
		expect( queryByTestId( 'inspector' ) ).toBeNull();
		fireEvent.click( getByText( 'select-n1' ) );
		expect( queryByTestId( 'inspector' ) ).not.toBeNull();
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
		const { getByText, getByTestId, queryByTestId, rerender } = render(
			<GraphView
				graph={ twoNodeGraph }
				frame={ Frame }
				resetKey="k"
				selection={ null }
			/>
		);
		// Internally select n1, then an external re-point to n2 must move the
		// inspector to n2 — only the re-sync effect can do this.
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
		// External clear (e.g. console "new"): selection→null hides inspector.
		rerender(
			<GraphView
				graph={ twoNodeGraph }
				frame={ Frame }
				resetKey="k"
				selection={ null }
			/>
		);
		expect( queryByTestId( 'inspector' ) ).toBeNull();
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
		// Start self-controlled (selection undefined) so selecting an edge is
		// the live state, then transition selection → null to force the
		// re-sync effect (the bug: it left the edge stale on a null clear).
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

	it( 'forwards paletteLoading to the Palette loading prop (not derived from catalog)', () => {
		// Non-empty catalog: a `! catalog.length` derivation would yield false,
		// so a true result proves the explicit prop is wired through.
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
} );
