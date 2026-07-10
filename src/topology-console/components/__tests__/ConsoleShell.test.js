import { render, fireEvent } from '@testing-library/react';
import ConsoleShell from '../ConsoleShell';

// Stub the three children so we assert wiring, not their internals.
let lastHeaderProps = null;
let lastGraphProps = null;
let lastReplProps = null;
jest.mock( '../Header', () => ( props ) => {
	lastHeaderProps = props;
	return <header data-testid="header" data-mode={ props.mode } />;
} );
jest.mock( '../GraphView', () => ( props ) => {
	lastGraphProps = props;
	return (
		<div data-testid="graph">
			{ props.frameProps?.onResetLayout && (
				<button onClick={ () => props.frameProps.onResetLayout() }>
					reset-layout
				</button>
			) }
			{ props.frameProps?.onResetGraph && (
				<button onClick={ () => props.frameProps.onResetGraph() }>
					reset-graph
				</button>
			) }
		</div>
	);
} );
jest.mock( '../ReplFooter', () => ( props ) => {
	lastReplProps = props;
	return <footer data-testid="repl" />;
} );

const baseProps = {
	ready: true,
	graph: { nodes: [], edges: [] },
	frame: () => null,
	frameProps: {},
	headerProps: { mode: 'view', path: '' },
	replProps: { prompt: '/', transcript: [] },
};

describe( 'ConsoleShell', () => {
	beforeEach( () => {
		lastHeaderProps = null;
		lastGraphProps = null;
		lastReplProps = null;
	} );

	it( 'mounts Header, GraphView, and ReplFooter when ready', () => {
		const { getByTestId } = render( <ConsoleShell { ...baseProps } /> );
		expect( getByTestId( 'header' ) ).not.toBeNull();
		expect( getByTestId( 'graph' ) ).not.toBeNull();
		expect( getByTestId( 'repl' ) ).not.toBeNull();
	} );

	it( 'passes the transcript obstruction to the canvas when the REPL is shown', () => {
		render(
			<ConsoleShell
				{ ...baseProps }
				showRepl={ true }
				canvasProps={ { bottomObstructionPx: 120 } }
			/>
		);
		expect( lastGraphProps.bottomObstructionPx ).toBe( 120 );
	} );

	it( 'zeroes the canvas obstruction when the REPL is hidden (edit mode), ignoring a stale value', () => {
		// Edit mode unmounts the ReplFooter; its stale height reserves no band.
		render(
			<ConsoleShell
				{ ...baseProps }
				showRepl={ false }
				canvasProps={ { bottomObstructionPx: 120 } }
			/>
		);
		expect( lastGraphProps.bottomObstructionPx ).toBe( 0 );
	} );

	it( 'forwards headerProps to Header', () => {
		render(
			<ConsoleShell
				{ ...baseProps }
				headerProps={ { mode: 'edit', path: 'demo.p0' } }
			/>
		);
		expect( lastHeaderProps.mode ).toBe( 'edit' );
		expect( lastHeaderProps.path ).toBe( 'demo.p0' );
	} );

	it( 'forwards replProps to ReplFooter', () => {
		const onSubmit = jest.fn();
		render(
			<ConsoleShell
				{ ...baseProps }
				replProps={ { prompt: '/x', onSubmit } }
			/>
		);
		expect( lastReplProps.prompt ).toBe( '/x' );
		expect( lastReplProps.onSubmit ).toBe( onSubmit );
	} );

	it( 'gates the canvas on ready: building placeholder instead of GraphView when not ready', () => {
		const { queryByTestId, container } = render(
			<ConsoleShell
				{ ...baseProps }
				ready={ false }
				buildingClassName="my-canvas-building"
			/>
		);
		expect( queryByTestId( 'graph' ) ).toBeNull();
		expect(
			container.querySelector( '.my-canvas-building' )
		).not.toBeNull();
	} );

	it( 'renders GraphView (not the placeholder) when ready', () => {
		const { queryByTestId, container } = render(
			<ConsoleShell
				{ ...baseProps }
				ready
				buildingClassName="my-canvas-building"
			/>
		);
		expect( queryByTestId( 'graph' ) ).not.toBeNull();
		expect( container.querySelector( '.my-canvas-building' ) ).toBeNull();
	} );

	it( 'wires the reset chips in frameProps through to the passed callbacks', () => {
		const onResetLayout = jest.fn();
		const onResetGraph = jest.fn();
		const { getByText } = render(
			<ConsoleShell
				{ ...baseProps }
				frameProps={ { onResetLayout, onResetGraph } }
			/>
		);
		fireEvent.click( getByText( 'reset-layout' ) );
		fireEvent.click( getByText( 'reset-graph' ) );
		expect( onResetLayout ).toHaveBeenCalledTimes( 1 );
		expect( onResetGraph ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'forwards graph and frame/canvas props to GraphView', () => {
		const graph = { nodes: [ { id: 'n1' } ], edges: [] };
		const frame = () => null;
		render(
			<ConsoleShell
				{ ...baseProps }
				graph={ graph }
				frame={ frame }
				canvasProps={ { interactive: true, editMode: false } }
			/>
		);
		expect( lastGraphProps.graph ).toBe( graph );
		expect( lastGraphProps.frame ).toBe( frame );
		expect( lastGraphProps.interactive ).toBe( true );
		expect( lastGraphProps.editMode ).toBe( false );
	} );

	it( 'hides the ReplFooter when showRepl is false', () => {
		const { queryByTestId } = render(
			<ConsoleShell { ...baseProps } showRepl={ false } />
		);
		expect( queryByTestId( 'repl' ) ).toBeNull();
	} );

	it( 'wraps the Header via the wrapHeader render-prop', () => {
		const { container, getByTestId } = render(
			<ConsoleShell
				{ ...baseProps }
				wrapHeader={ ( header ) => (
					<div className="my-header-wrap">{ header }</div>
				) }
			/>
		);
		const wrap = container.querySelector( '.my-header-wrap' );
		expect( wrap ).not.toBeNull();
		expect( wrap.contains( getByTestId( 'header' ) ) ).toBe( true );
	} );
} );
