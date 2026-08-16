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

// The backdrop is where position and z-index live, so a dialog opened OVER
// another modal layer — the Ask brief over a `@wordpress/components` one —
// raises itself there rather than inside the box.
test( 'puts backdropClassName on the backdrop, not the dialog', () => {
	const { container } = render(
		<Modal
			ariaLabel="x"
			onClose={ () => {} }
			className="on-the-box"
			backdropClassName="on-the-backdrop"
		>
			body
		</Modal>
	);
	const backdrop = container.querySelector(
		'.newspack-nodes-modal__backdrop'
	);
	expect( backdrop.className ).toContain( 'on-the-backdrop' );
	expect( backdrop.className ).not.toContain( 'on-the-box' );
	expect( container.querySelector( '[role="dialog"]' ).className ).toContain(
		'on-the-box'
	);
} );
