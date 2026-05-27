/**
 * CanvasFrame — decorative chrome around the SVG canvas. Tests the
 * conditional save/reset chips and the topology label area.
 */

import { render, fireEvent } from '@testing-library/react';
import CanvasFrame from '../CanvasFrame';

describe( 'CanvasFrame', () => {
	it( 'renders the topology label + sheet pad in the title block (worker scope)', () => {
		const { container } = render(
			<CanvasFrame topology="demo" partition={ 0 } isWorker>
				<svg data-testid="canvas-svg" />
			</CanvasFrame>
		);
		expect( container.textContent ).toContain( 'topologies/demo.tsl' );
		// Title block ends with `topology.pN`.
		expect( container.textContent ).toContain( 'demo.p0' );
	} );

	it( 'a worker scope shows the .tsl filename and `· Partition N`', () => {
		const { container } = render(
			<CanvasFrame topology="digest" partition={ 0 } isWorker />
		);
		expect( container.textContent ).toContain( 'topologies/digest.tsl' );
		expect( container.textContent ).toMatch( /· Partition 0/ );
	} );

	it( 'a non-worker scope (request scope) shows only the label, no .tsl line', () => {
		const { container } = render(
			<CanvasFrame
				topology="request scope"
				partition={ null }
				isWorker={ false }
			/>
		);
		expect( container.textContent ).toContain( 'request scope' );
		expect( container.textContent ).not.toMatch( /\.tsl/ );
		expect( container.textContent ).not.toMatch( /topologies\// );
		expect( container.textContent ).not.toMatch( /Partition/ );
	} );

	it( 'a non-worker scope sets the Sheet pad to the label, not `{topology}.p{partition}`', () => {
		const { container } = render(
			<CanvasFrame
				topology="local"
				partition={ null }
				isWorker={ false }
			/>
		);
		expect( container.textContent ).toContain( 'local' );
		expect( container.textContent ).not.toMatch( /\.p/ );
	} );

	it( 'omits the partition suffix when partition is null', () => {
		const { container } = render(
			<CanvasFrame topology="demo" partition={ null } />
		);
		expect( container.textContent ).not.toMatch( /Partition/ );
	} );

	it( 'shows the partition suffix when partition is set (worker scope)', () => {
		const { container } = render(
			<CanvasFrame topology="demo" partition={ 2 } isWorker />
		);
		expect( container.textContent ).toMatch( /Partition 2/ );
	} );

	it( 'renders Save Layout only in edit mode with onSaveLayout', () => {
		const onSaveLayout = jest.fn();
		const { getByText, queryByText, rerender } = render(
			<CanvasFrame
				topology="demo"
				partition={ 0 }
				editMode
				onSaveLayout={ onSaveLayout }
			/>
		);
		fireEvent.click( getByText( /Save layout/i ) );
		expect( onSaveLayout ).toHaveBeenCalled();
		// View mode (editMode=false) — hide Save.
		rerender(
			<CanvasFrame
				topology="demo"
				partition={ 0 }
				editMode={ false }
				onSaveLayout={ onSaveLayout }
			/>
		);
		expect( queryByText( /Save layout/i ) ).toBeNull();
	} );

	it( 'renders Reset Layout when onResetLayout is provided', () => {
		const onResetLayout = jest.fn();
		const { getByText, queryByText, rerender } = render(
			<CanvasFrame
				topology="demo"
				partition={ 0 }
				onResetLayout={ onResetLayout }
			/>
		);
		fireEvent.click( getByText( /Reset layout/i ) );
		expect( onResetLayout ).toHaveBeenCalled();
		rerender( <CanvasFrame topology="demo" partition={ 0 } /> );
		expect( queryByText( /Reset layout/i ) ).toBeNull();
	} );

	it( 'renders Reset Graph when onResetGraph is provided and fires it', () => {
		const onResetGraph = jest.fn();
		const { getByText, queryByText, rerender } = render(
			<CanvasFrame
				topology="demo"
				partition={ 0 }
				onResetGraph={ onResetGraph }
			/>
		);
		fireEvent.click( getByText( /Reset graph/i ) );
		expect( onResetGraph ).toHaveBeenCalled();
		rerender( <CanvasFrame topology="demo" partition={ 0 } /> );
		expect( queryByText( /Reset graph/i ) ).toBeNull();
	} );

	it( 'renders children inside the frame', () => {
		const { getByTestId } = render(
			<CanvasFrame topology="demo" partition={ 0 }>
				<div data-testid="inner" />
			</CanvasFrame>
		);
		expect( getByTestId( 'inner' ) ).not.toBeNull();
	} );
} );
