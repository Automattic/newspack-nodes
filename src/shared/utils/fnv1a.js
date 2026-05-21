/* eslint-disable no-bitwise */
/**
 * FNV-1a hash implementation. Must match PHP's fnv1a().
 */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * Compute FNV-1a 32-bit hash of a string with optional seed.
 *
 * @param {string} str  Input string to hash.
 * @param {number} seed Optional offset basis override.
 * @return {number} 32-bit unsigned hash.
 */
function fnv1a32( str, seed = FNV_OFFSET ) {
	let hash = seed;
	for ( let i = 0; i < str.length; i++ ) {
		hash ^= str.charCodeAt( i );
		hash = Math.imul( hash, FNV_PRIME ) >>> 0;
	}
	return hash;
}

/**
 * Compute FNV-1a hash producing 12 hex characters (two seeded passes).
 *
 * @param {string} str Input string to hash.
 * @return {string} 12-character hex string.
 */
export default function fnv1a( str ) {
	const hash1 = fnv1a32( str );
	const hash2 = fnv1a32( str, hash1 ^ 0x811c9dc5 ); // Different seed.
	// Take all 32 bits from hash1, 16 bits from hash2.
	const hex1 = hash1.toString( 16 ).padStart( 8, '0' );
	const hex2 = ( hash2 & 0xffff ).toString( 16 ).padStart( 4, '0' );
	return hex1 + hex2;
}
