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
	render(
		<Modal ariaLabel="x" onClose={ onClose }>
			<p>body</p>
		</Modal>
	);

	fireEvent.mouseDown( screen.getByText( 'body' ) );
	expect( onClose ).not.toHaveBeenCalled();

	fireEvent.mouseDown(
		document.body.querySelector( '.newspack-nodes-modal__backdrop' )
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

// @longform A caller's own box is routinely a stacking context — a dashboard
// shell is `position: fixed; z-index: 99` — and a z-index inside one can only
// rank against its siblings there. A modal that must cover a `@wordpress/
// components` dialog portalled to the body at 100000 therefore cannot win from
// inside the tree, however high it raises its backdrop.
test( 'escapes the caller stacking context by rendering into the body', () => {
	const { container } = render(
		<div style={ { position: 'fixed', zIndex: 99 } }>
			<Modal ariaLabel="x" onClose={ () => {} } backdropClassName="deep">
				<p>body</p>
			</Modal>
		</div>
	);

	expect( container.querySelector( '.deep' ) ).toBeNull();
	const backdrop = document.body.querySelector( '.deep' );
	expect( backdrop ).not.toBeNull();
	expect( backdrop.closest( '[style*="z-index"]' ) ).toBeNull();
} );

// The skin lives on ancestors, so a host outside the tree carries them itself:
// the tokens resolve at `<html>`, but the type and colour rules key off these.
test( 'the portal host carries the skin classes', () => {
	render(
		<Modal ariaLabel="x" onClose={ () => {} }>
			<p>body</p>
		</Modal>
	);

	const host = document.body
		.querySelector( '.newspack-nodes-modal__backdrop' )
		.closest( '.newspack-nodes-skin-root' );
	expect( host ).not.toBeNull();
	expect( host.className ).toBe(
		'newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
	);
	expect( host.style.display ).toBe( 'contents' );
} );

// The backdrop is where position and z-index live, so a dialog opened OVER
// another modal layer — the Ask brief over a `@wordpress/components` one —
// raises itself there rather than inside the box.
test( 'puts backdropClassName on the backdrop, not the dialog', () => {
	render(
		<Modal
			ariaLabel="x"
			onClose={ () => {} }
			className="on-the-box"
			backdropClassName="on-the-backdrop"
		>
			body
		</Modal>
	);
	const backdrop = document.body.querySelector(
		'.newspack-nodes-modal__backdrop'
	);
	expect( backdrop.className ).toContain( 'on-the-backdrop' );
	expect( backdrop.className ).not.toContain( 'on-the-box' );
	expect( screen.getByRole( 'dialog' ).className ).toContain( 'on-the-box' );
} );
