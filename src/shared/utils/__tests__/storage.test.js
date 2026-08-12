/**
 * storage — the window guard and the swallow, in one place.
 */

import { readStorage, writeStorage } from '../storage';

const withStorage = ( impl ) => {
	const original = window.localStorage;
	Object.defineProperty( window, 'localStorage', {
		value: impl,
		configurable: true,
	} );
	return () =>
		Object.defineProperty( window, 'localStorage', {
			value: original,
			configurable: true,
		} );
};

it( 'reads a stored value', () => {
	const restore = withStorage( { getItem: () => 'zebra' } );
	expect( readStorage( 'k' ) ).toBe( 'zebra' );
	restore();
} );

it( 'answers null when storage throws, rather than propagating', () => {
	const restore = withStorage( {
		getItem: () => {
			throw new Error( 'SecurityError' );
		},
	} );
	expect( readStorage( 'k' ) ).toBeNull();
	restore();
} );

it( 'swallows a failed write, because the caller cannot act on it', () => {
	const restore = withStorage( {
		setItem: () => {
			throw new Error( 'QuotaExceededError' );
		},
	} );
	expect( () => writeStorage( 'k', 'v' ) ).not.toThrow();
	restore();
} );
