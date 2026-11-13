/* eslint-env jest */
/**
 * An `Invitation` is an empty section's words and the one control that acts
 * on them; any other prop lands on the control.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import Invitation from '../Invitation';

describe( 'Invitation', () => {
	it( 'says its text beside a button that runs what it is handed', () => {
		const onClick = jest.fn();
		const { container } = render(
			<Invitation
				text="The harbor desk holds no notes."
				label="Open a harbor note"
				onClick={ onClick }
			/>
		);
		expect( container.textContent ).toBe(
			'The harbor desk holds no notes. Open a harbor note'
		);
		const button = screen.getByRole( 'button', {
			name: 'Open a harbor note',
		} );
		expect( button.getAttribute( 'type' ) ).toBe( 'button' );
		expect( button.classList.contains( 'button' ) ).toBe( true );
		fireEvent.click( button );
		expect( onClick ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'hands every other prop to the control, aria-disabled included', () => {
		render(
			<Invitation
				text="Nothing yet."
				label="Start"
				aria-disabled="true"
				data-quill="seven"
			/>
		);
		const button = screen.getByRole( 'button', { name: 'Start' } );
		expect( button.getAttribute( 'aria-disabled' ) ).toBe( 'true' );
		expect( button.getAttribute( 'data-quill' ) ).toBe( 'seven' );
	} );
} );
