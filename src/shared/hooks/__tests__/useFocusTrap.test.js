/**
 * useFocusTrap's edges beyond the dialogs that call it: a dialog with nothing
 * to tab to, focus that starts outside it, and a ref that never attaches.
 */

import { render, renderHook, screen, fireEvent } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { useFocusTrap } from '../useFocusTrap';

function Dialog( { children, returnFocus } ) {
	const ref = useRef( null );
	useFocusTrap( ref, returnFocus );
	return (
		<div ref={ ref } role="dialog">
			{ children }
		</div>
	);
}

test( 'Tab in a dialog with nothing tabbable goes nowhere', () => {
	render( <Dialog>text-731</Dialog> );

	expect( fireEvent.keyDown( document, { key: 'Tab' } ) ).toBe( false );
} );

test( 'Tab with focus outside the dialog moves it to the first control', () => {
	render( <button type="button">outside-732</button> );
	render(
		<Dialog>
			<button type="button">first-732</button>
			<button type="button">last-732</button>
		</Dialog>
	);
	screen.getByText( 'outside-732' ).focus();

	fireEvent.keyDown( document, { key: 'Tab' } );
	expect( document.activeElement ).toBe( screen.getByText( 'first-732' ) );
} );

test( 'a ref that never attaches traps nothing', () => {
	renderHook( () => useFocusTrap( { current: null } ) );

	expect( fireEvent.keyDown( document, { key: 'Tab' } ) ).toBe( true );
} );

test( 'closing hands focus to the element returnFocus names', () => {
	render(
		<>
			<button type="button">trigger-734</button>
			<button type="button">elsewhere-734</button>
		</>
	);
	const trigger = { current: screen.getByText( 'trigger-734' ) };
	screen.getByText( 'elsewhere-734' ).focus();
	const { unmount } = render(
		<Dialog returnFocus={ trigger }>
			<button type="button">inside-734</button>
		</Dialog>
	);

	unmount();
	expect( document.activeElement ).toBe( trigger.current );
} );

test( 'a returnFocus holding nothing hands focus back to what held it', () => {
	render( <button type="button">opener-735</button> );
	const opener = screen.getByText( 'opener-735' );
	opener.focus();
	const { unmount } = render(
		<Dialog returnFocus={ { current: null } }>
			<button type="button">inside-735</button>
		</Dialog>
	);
	screen.getByText( 'inside-735' ).focus();

	unmount();
	expect( document.activeElement ).toBe( opener );
} );
