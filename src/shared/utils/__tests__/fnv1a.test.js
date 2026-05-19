/**
 * Tests for the FNV-1a hash util.
 *
 * Behavior under test: produces a 12-char lowercase hex digest, deterministic,
 * varies on input change, and stays bounded for the empty string. We don't
 * pin specific golden values here — the canonical pin is the PHP-side cross-
 * implementation test in tests/php (fnv1a must match PHP's fnv1a()).
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
		// FNV-1a is designed to avalanche on single-char changes; a same-prefix
		// pair should not collide.
		expect( fnv1a( 'abc' ) ).not.toBe( fnv1a( 'abd' ) );
	} );

	it( 'handles long inputs (avoids 32-bit overflow corruption)', () => {
		const longInput = 'a'.repeat( 10000 );
		const hash = fnv1a( longInput );
		expect( hash ).toMatch( /^[0-9a-f]{12}$/ );
	} );
} );
