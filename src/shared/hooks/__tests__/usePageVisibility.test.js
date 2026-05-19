/**
 * Tests for usePageVisibility — tracks document.visibilityState across
 * visibilitychange events and unmounts cleanly.
 */

import { renderHook, act } from '@testing-library/react';
import usePageVisibility from '../usePageVisibility';

describe( 'usePageVisibility', () => {
	const setVisibility = ( state ) => {
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => state,
		} );
		document.dispatchEvent( new Event( 'visibilitychange' ) );
	};

	beforeEach( () => {
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'visible',
		} );
	} );

	it( 'returns true when document is initially visible', () => {
		const { result } = renderHook( () => usePageVisibility() );
		expect( result.current ).toBe( true );
	} );

	it( 'returns false when document is initially hidden', () => {
		Object.defineProperty( document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		} );
		const { result } = renderHook( () => usePageVisibility() );
		expect( result.current ).toBe( false );
	} );

	it( 'updates when visibility flips to hidden', () => {
		const { result } = renderHook( () => usePageVisibility() );
		expect( result.current ).toBe( true );
		act( () => setVisibility( 'hidden' ) );
		expect( result.current ).toBe( false );
	} );

	it( 'updates back to visible after a flip', () => {
		const { result } = renderHook( () => usePageVisibility() );
		act( () => setVisibility( 'hidden' ) );
		act( () => setVisibility( 'visible' ) );
		expect( result.current ).toBe( true );
	} );

	it( 'removes its visibilitychange listener on unmount', () => {
		const spy = jest.spyOn( document, 'removeEventListener' );
		const { unmount } = renderHook( () => usePageVisibility() );
		unmount();
		expect( spy ).toHaveBeenCalledWith(
			'visibilitychange',
			expect.any( Function )
		);
		spy.mockRestore();
	} );
} );
