/**
 * useLeaveGuard — while a page holds a change, leaving the page by a
 * wp-admin menu link, a reload or closing the tab asks first, through the
 * browser's own `beforeunload` prompt.
 */

import { renderHook } from '@testing-library/react';
import { useLeaveGuard } from '../useLeaveGuard';

/**
 * Dispatch a cancelable `beforeunload`, as a navigation away does.
 *
 * @return {Event} The event, once every listener has run.
 */
function unload() {
	const event = new Event( 'beforeunload', { cancelable: true } );
	window.dispatchEvent( event );
	return event;
}

it( 'cancels leaving while the page holds a change', () => {
	renderHook( () => useLeaveGuard( true ) );
	const event = unload();
	expect( event.defaultPrevented ).toBe( true );
	expect( event.returnValue ).toBe( false );
} );

it( 'lets the page go while it holds no change', () => {
	renderHook( () => useLeaveGuard( false ) );
	expect( unload().defaultPrevented ).toBe( false );
} );

it( 'lets the page go once the change is saved', () => {
	const { rerender } = renderHook( ( { dirty } ) => useLeaveGuard( dirty ), {
		initialProps: { dirty: true },
	} );
	rerender( { dirty: false } );
	expect( unload().defaultPrevented ).toBe( false );
} );

it( 'removes its listener when it unmounts', () => {
	const removed = jest.spyOn( window, 'removeEventListener' );
	const { unmount } = renderHook( () => useLeaveGuard( true ) );
	unmount();
	expect( removed ).toHaveBeenCalledWith(
		'beforeunload',
		expect.any( Function )
	);
	expect( unload().defaultPrevented ).toBe( false );
	removed.mockRestore();
} );

it( 'keeps asking for one page part while another lets go', () => {
	const kept = renderHook( () => useLeaveGuard( true ) );
	const gone = renderHook( () => useLeaveGuard( true ) );
	gone.unmount();
	expect( unload().defaultPrevented ).toBe( true );
	kept.unmount();
} );
