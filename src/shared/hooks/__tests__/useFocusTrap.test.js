/**
 * useFocusTrap's edges beyond the dialogs that call it: a dialog with nothing
 * to tab to, focus that starts outside it, and a ref that never attaches.
 */

import { render, renderHook, screen, fireEvent } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { TABBABLE, useFocusTrap } from '../useFocusTrap';

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

	expect(
		fireEvent.keyDown( screen.getByText( 'text-731' ), { key: 'Tab' } )
	).toBe( false );
} );

test( 'Tab with focus outside the dialog is left to the browser', () => {
	render( <button type="button">outside-732</button> );
	render(
		<Dialog>
			<button type="button">first-732</button>
			<button type="button">last-732</button>
		</Dialog>
	);
	const outside = screen.getByText( 'outside-732' );
	outside.focus();

	expect( fireEvent.keyDown( outside, { key: 'Tab' } ) ).toBe( true );
	expect( document.activeElement ).toBe( outside );
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

test( 'Tab from a summary between two controls is left to the browser', () => {
	render(
		<Dialog>
			<button type="button">first-736</button>
			<details>
				<summary>summary-736</summary>
			</details>
			<button type="button">last-736</button>
		</Dialog>
	);
	const summary = screen.getByText( 'summary-736' );
	summary.focus();

	expect( fireEvent.keyDown( summary, { key: 'Tab' } ) ).toBe( true );
	expect( document.activeElement ).toBe( summary );
} );

test( 'Tab from a focused element off the list is left to the browser', () => {
	render(
		<Dialog>
			<button type="button">first-737</button>
			<div tabIndex={ -1 }>region-737</div>
			<button type="button">last-737</button>
		</Dialog>
	);
	const region = screen.getByText( 'region-737' );
	region.focus();

	expect( fireEvent.keyDown( region, { key: 'Tab' } ) ).toBe( true );
	expect( document.activeElement ).toBe( region );
} );

test.each( [
	[ 'a summary', <summary key="s">last-738</summary>, 'summary' ],
	[
		'a contenteditable region',
		<div
			key="c"
			contentEditable="plaintext-only"
			suppressContentEditableWarning
		>
			last-738
		</div>,
		'div',
	],
] )( 'Shift+Tab from the first control wraps to %s', ( _, last, tag ) => {
	const { container } = render(
		<Dialog>
			<button type="button">first-738</button>
			{ 'summary' === tag ? <details>{ last }</details> : last }
		</Dialog>
	);
	const first = screen.getByText( 'first-738' );
	first.focus();

	fireEvent.keyDown( first, { key: 'Tab', shiftKey: true } );

	expect( document.activeElement ).toBe(
		container.ownerDocument.querySelector( `[role="dialog"] ${ tag }` )
	);
} );

test( 'a contenteditable false region is off the list', () => {
	render(
		<Dialog>
			<button type="button">first-739</button>
			<button type="button">last-739</button>
			<div contentEditable={ false } tabIndex={ -1 }>
				fixed-739
			</div>
		</Dialog>
	);
	const first = screen.getByText( 'first-739' );
	first.focus();

	fireEvent.keyDown( first, { key: 'Tab', shiftKey: true } );

	expect( document.activeElement ).toBe( screen.getByText( 'last-739' ) );
} );

test.each( [
	[ '<audio controls></audio>', true ],
	[ '<video controls></video>', true ],
	[ '<audio></audio>', false ],
	[ '<video></video>', false ],
] )( 'the tabbable list holds %s: %s', ( markup, listed ) => {
	const host = document.createElement( 'div' );
	host.innerHTML = markup;

	expect( host.firstElementChild.matches( TABBABLE ) ).toBe( listed );
} );

test( 'Tab from an off-list element after the last control wraps to the first', () => {
	render(
		<Dialog>
			<button type="button">first-740</button>
			<button type="button">last-740</button>
			<ul>
				<li tabIndex={ -1 }>row-740</li>
			</ul>
		</Dialog>
	);
	const row = screen.getByText( 'row-740' );
	row.focus();

	expect( fireEvent.keyDown( row, { key: 'Tab' } ) ).toBe( false );
	expect( document.activeElement ).toBe( screen.getByText( 'first-740' ) );
} );

test( 'Shift+Tab from an off-list element before the first control wraps to the last', () => {
	render(
		<Dialog>
			<ul>
				<li tabIndex={ -1 }>row-741</li>
			</ul>
			<button type="button">first-741</button>
			<button type="button">last-741</button>
		</Dialog>
	);
	const row = screen.getByText( 'row-741' );
	row.focus();

	expect( fireEvent.keyDown( row, { key: 'Tab', shiftKey: true } ) ).toBe(
		false
	);
	expect( document.activeElement ).toBe( screen.getByText( 'last-741' ) );
} );

test( 'Shift+Tab from an off-list region between two controls is left to the browser', () => {
	render(
		<Dialog>
			<button type="button">first-742</button>
			<div tabIndex={ -1 }>region-742</div>
			<button type="button">last-742</button>
		</Dialog>
	);
	const region = screen.getByText( 'region-742' );
	region.focus();

	expect( fireEvent.keyDown( region, { key: 'Tab', shiftKey: true } ) ).toBe(
		true
	);
	expect( document.activeElement ).toBe( region );
} );
