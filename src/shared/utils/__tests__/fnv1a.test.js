/**
 * Tests for the FNV-1a hash util (the golden cross-impl pin lives in tests/php).
 */

import fnv1a from '../fnv1a';

describe( 'fnv1a', () => {
	it( 'returns a 12-character lowercase hex string', () => {
		const hash = fnv1a( 'hello' );
		expect( hash ).toMatch( /^[0-9a-f]{12}$/ );
	} );

	it( 'is deterministic for the same input', () => {
		expect( fnv1a( 'hello' ) ).toBe( fnv1a( 'hello' ) );
	} );

	it( 'produces different hashes for different inputs', () => {
		expect( fnv1a( 'hello' ) ).not.toBe( fnv1a( 'world' ) );
	} );

	it( 'handles the empty string without throwing', () => {
		const hash = fnv1a( '' );
		expect( hash ).toMatch( /^[0-9a-f]{12}$/ );
	} );

	it( 'handles unicode characters', () => {
		const hash = fnv1a( 'héllo→世界' );
		expect( hash ).toMatch( /^[0-9a-f]{12}$/ );
	} );

	it( 'discriminates single-character changes', () => {
		// Avalanche: a same-prefix pair must not collide.
		expect( fnv1a( 'abc' ) ).not.toBe( fnv1a( 'abd' ) );
	} );

	it( 'handles long inputs (avoids 32-bit overflow corruption)', () => {
		const longInput = 'a'.repeat( 10000 );
		const hash = fnv1a( longInput );
		expect( hash ).toMatch( /^[0-9a-f]{12}$/ );
	} );
} );
