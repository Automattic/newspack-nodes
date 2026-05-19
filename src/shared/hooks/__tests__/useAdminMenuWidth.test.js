/**
 * Tests for useAdminMenuWidth — tracks the WP admin menu width by reading
 * #adminmenuwrap.offsetWidth and re-reads on body-class mutations + resize.
 */

import { renderHook, act } from '@testing-library/react';
import useAdminMenuWidth from '../useAdminMenuWidth';

describe( 'useAdminMenuWidth', () => {
	let menu;

	const installMenu = ( width ) => {
		menu = document.createElement( 'div' );
		menu.id = 'adminmenuwrap';
		Object.defineProperty( menu, 'offsetWidth', {
			configurable: true,
			get: () => width,
		} );
		document.body.appendChild( menu );
	};

	const setMenuWidth = ( width ) => {
		Object.defineProperty( menu, 'offsetWidth', {
			configurable: true,
			get: () => width,
		} );
	};

	afterEach( () => {
		while ( document.body.firstChild ) {
			document.body.firstChild.remove();
		}
		document.body.removeAttribute( 'class' );
		menu = null;
	} );

	it( 'returns 0 when there is no #adminmenuwrap in the DOM', () => {
		const { result } = renderHook( () => useAdminMenuWidth() );
		expect( result.current ).toBe( 0 );
	} );

	it( 'reports the menu width on mount', () => {
		installMenu( 160 );
		const { result } = renderHook( () => useAdminMenuWidth() );
		expect( result.current ).toBe( 160 );
	} );

	it( 'updates on window resize', () => {
		installMenu( 160 );
		const { result } = renderHook( () => useAdminMenuWidth() );
		act( () => {
			setMenuWidth( 36 );
			window.dispatchEvent( new Event( 'resize' ) );
		} );
		expect( result.current ).toBe( 36 );
	} );

	it( 'updates when body class changes (menu fold)', async () => {
		installMenu( 160 );
		const { result } = renderHook( () => useAdminMenuWidth() );
		await act( async () => {
			setMenuWidth( 36 );
			document.body.classList.add( 'folded' );
			// Let the MutationObserver microtask fire.
			await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		} );
		expect( result.current ).toBe( 36 );
	} );

	it( 'removes its resize listener on unmount', () => {
		installMenu( 160 );
		const spy = jest.spyOn( window, 'removeEventListener' );
		const { unmount } = renderHook( () => useAdminMenuWidth() );
		unmount();
		expect( spy ).toHaveBeenCalledWith( 'resize', expect.any( Function ) );
		spy.mockRestore();
	} );
} );
