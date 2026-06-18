/**
 * Tests for useAdminChromeColors — reads the WP admin bar's color scheme off the
 * live DOM so DevTools chrome blends with the active scheme; falls back when the
 * bar is absent (standalone overlay / tests).
 */

import { renderHook } from '@testing-library/react';
import useAdminChromeColors from '../useAdminChromeColors';

describe( 'useAdminChromeColors', () => {
	const installBar = ( bg, fg ) => {
		const bar = document.createElement( 'div' );
		bar.id = 'wpadminbar';
		bar.style.backgroundColor = bg;
		bar.style.color = fg;
		document.body.appendChild( bar );
		return bar;
	};

	afterEach( () => {
		while ( document.body.firstChild ) {
			document.body.firstChild.remove();
		}
		document.body.removeAttribute( 'class' );
	} );

	it( 'returns the default fallback when there is no admin bar', () => {
		const { result } = renderHook( () => useAdminChromeColors() );
		expect( result.current ).toEqual( {
			background: '#1e1e1e',
			foreground: '#ffffff',
		} );
	} );

	it( 'respects a custom fallback when the bar is absent', () => {
		const { result } = renderHook( () =>
			useAdminChromeColors( {
				background: '#000',
				foreground: '#abc',
			} )
		);
		expect( result.current ).toEqual( {
			background: '#000',
			foreground: '#abc',
		} );
	} );

	it( 'reads the admin bar background + text color on mount', () => {
		installBar( 'rgb(89, 82, 76)', 'rgb(255, 245, 238)' );
		const { result } = renderHook( () => useAdminChromeColors() );
		expect( result.current ).toEqual( {
			background: 'rgb(89, 82, 76)',
			foreground: 'rgb(255, 245, 238)',
		} );
	} );

	it( 'ignores a transparent bar background and keeps the fallback', () => {
		const bar = installBar( 'rgb(0, 0, 0)', 'rgb(240, 240, 241)' );
		bar.style.backgroundColor = 'rgba(0, 0, 0, 0)';
		const { result } = renderHook( () => useAdminChromeColors() );
		expect( result.current.background ).toBe( '#1e1e1e' );
		expect( result.current.foreground ).toBe( 'rgb(240, 240, 241)' );
	} );
} );
