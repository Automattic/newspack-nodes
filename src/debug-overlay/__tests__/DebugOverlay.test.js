import { render, fireEvent } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import DebugOverlay from '../DebugOverlay';

describe( 'DebugOverlay', () => {
	beforeEach( () => {
		Core.reset();
		window.localStorage.clear();
	} );

	it( 'renders nothing when debug is disabled', () => {
		const { container } = render( <DebugOverlay search="" /> );
		expect( container.firstChild ).toBeNull();
	} );

	it( 'shows a toggle FAB when enabled, and opens the panel on click', () => {
		mountExospine();
		const { getByRole, queryByTestId } = render(
			<DebugOverlay search="?nodes-debug=1" />
		);
		expect( queryByTestId( 'debug-panel' ) ).toBeNull();
		fireEvent.click( getByRole( 'button', { name: /debug/i } ) );
		expect( queryByTestId( 'debug-panel' ) ).not.toBeNull();
	} );
} );
