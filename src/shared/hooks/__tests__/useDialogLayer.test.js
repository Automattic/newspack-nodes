/**
 * useDialogLayer's ranks: the order of first render decides the topmost
 * dialog, and a trap given an `isActive` that answers false leaves Tab to
 * the browser.
 */

import { render, renderHook, screen, fireEvent } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { useDialogLayer } from '../useDialogLayer';
import { useFocusTrap } from '../useFocusTrap';

test( 'two mounted layers: only the later is top', () => {
	const earlier = renderHook( () => useDialogLayer() );
	const later = renderHook( () => useDialogLayer() );

	expect( earlier.result.current() ).toBe( false );
	expect( later.result.current() ).toBe( true );
} );

test( 'unmounting the top makes the earlier top again', () => {
	const earlier = renderHook( () => useDialogLayer() );
	const later = renderHook( () => useDialogLayer() );

	later.unmount();
	expect( earlier.result.current() ).toBe( true );
	earlier.unmount();
} );

function Trapped( { label, isActive } ) {
	const ref = useRef( null );
	useFocusTrap( ref, null, isActive );
	return (
		<div ref={ ref } role="dialog">
			<button type="button">{ label }-first</button>
			<button type="button">{ label }-last</button>
		</div>
	);
}

test( 'a trap whose isActive answers false leaves Tab to the browser', () => {
	render( <Trapped label="inert-741" isActive={ () => false } /> );
	const last = screen.getByText( 'inert-741-last' );
	last.focus();

	expect( fireEvent.keyDown( last, { key: 'Tab' } ) ).toBe( true );
	expect( document.activeElement ).toBe(
		screen.getByText( 'inert-741-last' )
	);
} );

test( 'a trap whose isActive answers true wraps Tab at the edge', () => {
	render( <Trapped label="live-742" isActive={ () => true } /> );
	const last = screen.getByText( 'live-742-last' );
	last.focus();

	expect( fireEvent.keyDown( last, { key: 'Tab' } ) ).toBe( false );
	expect( document.activeElement ).toBe(
		screen.getByText( 'live-742-first' )
	);
} );

test( 'a re-render with a new isActive does not hand focus back early', () => {
	render( <button type="button">opener-743</button> );
	screen.getByText( 'opener-743' ).focus();
	const { rerender } = render(
		<Trapped label="r-743" isActive={ () => true } />
	);
	screen.getByText( 'r-743-last' ).focus();

	rerender( <Trapped label="r-743" isActive={ () => true } /> );
	expect( document.activeElement ).toBe( screen.getByText( 'r-743-last' ) );
} );
