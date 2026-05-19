/**
 * CanvasFrame — decorative chrome around the SVG canvas. Tests the
 * conditional save/reset chips and the topology label area.
 */

import { render, fireEvent } from '@testing-library/react';
import CanvasFrame from '../CanvasFrame';

describe( 'CanvasFrame', () => {
	it( 'renders the topology label + sheet pad in the title block', () => {
		const { container } = render(
			<CanvasFrame topology="demo" partition={ 0 }>
				<svg data-testid="canvas-svg" />
			</CanvasFrame>
		);
		expect( container.textContent ).toContain( 'topologies/demo.tsl' );
		// Title block ends with `topology.pN`.
		expect( container.textContent ).toContain( 'demo.p0' );
	} );

	it( 'omits the partition suffix when partition is null', () => {
		const { container } = render(
			<CanvasFrame topology="demo" partition={ null } />
		);
		expect( container.textContent ).not.toMatch( /Partition/ );
	} );

	it( 'shows the partition suffix when partition is set', () => {
		const { container } = render(
			<CanvasFrame topology="demo" partition={ 2 } />
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

	it( 'renders children inside the frame', () => {
		const { getByTestId } = render(
			<CanvasFrame topology="demo" partition={ 0 }>
				<div data-testid="inner" />
			</CanvasFrame>
		);
		expect( getByTestId( 'inner' ) ).not.toBeNull();
	} );
} );
