/**
 * useFocusTrap's edges beyond the dialogs that call it: a dialog with nothing
 * to tab to, focus that starts outside it, and a ref that never attaches.
 */

import { render, renderHook, screen, fireEvent } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { useFocusTrap } from '../useFocusTrap';

function Dialog( { children } ) {
	const ref = useRef( null );
	useFocusTrap( ref );
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
