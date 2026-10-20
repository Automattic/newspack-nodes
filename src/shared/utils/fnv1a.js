/**
 * fnv1a — a string's 12-character FNV-1a key, the twin of event-logger-nodes'
 * PHP `Log_Manager::url_hash()`.
 *
 * Both ports hash the string's UTF-8 bytes, so a key computed in the browser
 * and one computed in PHP agree on every string; a divergence points a deep
 * link at no row, quietly, with nothing to raise. What a caller hashes is the
 * caller's to decide. `tests/fixtures/fnv1a-hashes.json` holds the two ports
 * to each other across ASCII and two-, three- and four-byte characters.
 */

/** FNV-1a's 32-bit offset basis, the hash every pass starts from. */
const FNV_OFFSET = 2166136261;

/** FNV-1a's 32-bit prime, the multiplier of each round. */
const FNV_PRIME = 16777619;

/**
 * Compute the FNV-1a 32-bit hash of a string's UTF-8 bytes.
 *
 * `Math.imul` and `>>> 0` are what hold the arithmetic to 32 bits. A plain
 * `hash * FNV_PRIME` passes 2^53 on the very first round, so the double drops
 * the low bits that PHP's `& 0xFFFFFFFF` keeps and the two ports part company
 * on character one.
 *
 * @param {Uint8Array} bytes  The string's UTF-8 bytes.
 * @param {number}     [seed] Offset basis to start from, defaulting to FNV-1a's.
 * @return {number} The hash as an unsigned 32-bit integer.
 */
function fnv1a32( bytes, seed = FNV_OFFSET ) {
	let hash = seed;
	for ( const byte of bytes ) {
		hash ^= byte;
		hash = Math.imul( hash, FNV_PRIME ) >>> 0;
	}
	return hash;
}

/**
 * Hash a string to the 12 hex characters every URL key is written as.
 *
 * Two seeded passes widen the key from 32 bits to 48: an even chance of a
 * collision moves from roughly 77,000 distinct URLs to roughly 20 million.
 * The second pass reseeds with the first hash XORed against the offset basis
 * (`0x811c9dc5` is FNV_OFFSET in hex) and contributes its low 16 bits, so the
 * width comes from one hash family rather than two.
 *
 * @param {string} str String to hash.
 * @return {string} Twelve lowercase hex characters.
 */
export default function fnv1a( str ) {
	const bytes = new TextEncoder().encode( str );
	const hash1 = fnv1a32( bytes );
	const hash2 = fnv1a32( bytes, hash1 ^ 0x811c9dc5 );
	const hex1 = hash1.toString( 16 ).padStart( 8, '0' );
	const hex2 = ( hash2 & 0xffff ).toString( 16 ).padStart( 4, '0' );
	return hex1 + hex2;
}
