/**
 * ThemedRoot is the no-box token-provider that puts a console-selected skin's
 * universal tokens (--paper/--ink/--cyan/…) in scope above a standalone
 * dashboard root. It reads the persisted skin once at mount via the shared
 * initSkin and renders a `display:contents` wrapper carrying the explicit
 * skinned, non-graph product root contract.
 */

import { createElement } from 'react';
import { render } from '@testing-library/react';
import ThemedRoot from '../ThemedRoot';
import { THEME_STORAGE_KEY } from '@newspack-nodes/shared/theme';

describe( 'ThemedRoot', () => {
	afterEach( () => window.localStorage.clear() );

	it( 'wraps children in the exact display:contents skinned non-graph provider', () => {
		const { container, unmount } = render(
			createElement(
				ThemedRoot,
				null,
				createElement( 'span', { 'data-testid': 'child' }, 'hi' )
			)
		);
		const wrapper = container.firstElementChild;
		expect( wrapper ).not.toBeNull();
		expect( wrapper.className ).toBe(
			'newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
		);
		expect( wrapper.classList.contains( 'topology-app' ) ).toBe( false );
		expect( wrapper.style.display ).toBe( 'contents' );
		// No font-family override: the skin's font cascades in.
		expect( wrapper.style.fontFamily ).toBe( '' );
		expect(
			wrapper.querySelector( '[data-testid="child"]' )
		).not.toBeNull();
		unmount();
	} );

	it( 'applies the persisted skin as the global <html> class on mount', () => {
		window.localStorage.setItem( THEME_STORAGE_KEY, 'crt' );
		const { unmount } = render( createElement( ThemedRoot, null, 'x' ) );
		expect(
			document.documentElement.classList.contains( 'theme-crt' )
		).toBe( true );
		unmount();
	} );

	it( 'falls back to the default skin class for an absent preference', () => {
		const { unmount } = render( createElement( ThemedRoot, null, 'x' ) );
		expect(
			document.documentElement.classList.contains( 'theme-newspack' )
		).toBe( true );
		unmount();
	} );

	it( 'paints the WP-admin body with the resolved skin surface, restored on unmount', () => {
		// jsdom resolves no CSS, so mock the probe span's computed colour.
		const real = window.getComputedStyle.bind( window );
		const spy = jest
			.spyOn( window, 'getComputedStyle' )
			.mockImplementation( ( el, pseudo ) =>
				el?.tagName === 'SPAN'
					? { backgroundColor: 'rgb(2, 10, 5)' }
					: real( el, pseudo )
			);
		const { unmount } = render( createElement( ThemedRoot, null, 'x' ) );
		expect( document.body.style.background ).toBe( 'rgb(2, 10, 5)' );
		unmount();
		expect( document.body.style.background ).toBe( '' );
		spy.mockRestore();
	} );
} );
