/**
 * The shared plain-DOM modal shell. Dashboards had been declaring their own
 * backdrop + dialog box with per-dashboard selectors; this is the one control.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import Modal from '../Modal';

test( 'it renders a labelled dialog carrying the canonical modal role', () => {
	render(
		<Modal ariaLabel="Add thing" onClose={ () => {} }>
			<p>body</p>
		</Modal>
	);

	const dialog = screen.getByRole( 'dialog' );
	expect( dialog.getAttribute( 'aria-label' ) ).toBe( 'Add thing' );
	expect( dialog.getAttribute( 'aria-modal' ) ).toBe( 'true' );
	expect( dialog.className ).toContain( 'newspack-nodes-modal' );
	expect( screen.getByText( 'body' ) ).toBeTruthy();
} );

test( 'escape closes it', () => {
	const onClose = jest.fn();
	render(
		<Modal ariaLabel="x" onClose={ onClose }>
			b
		</Modal>
	);

	fireEvent.keyDown( document, { key: 'Escape' } );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'a backdrop mousedown closes it but a click inside does not', () => {
	const onClose = jest.fn();
	const { container } = render(
		<Modal ariaLabel="x" onClose={ onClose }>
			<p>body</p>
		</Modal>
	);

	fireEvent.mouseDown( screen.getByText( 'body' ) );
	expect( onClose ).not.toHaveBeenCalled();

	fireEvent.mouseDown(
		container.querySelector( '.newspack-nodes-modal__backdrop' )
	);
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'the listener is removed on unmount', () => {
	const onClose = jest.fn();
	const { unmount } = render(
		<Modal ariaLabel="x" onClose={ onClose }>
			b
		</Modal>
	);

	unmount();
	fireEvent.keyDown( document, { key: 'Escape' } );
	expect( onClose ).not.toHaveBeenCalled();
} );
