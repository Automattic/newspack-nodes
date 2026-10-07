/**
 * log-position — the one JS writer and the one JS reader of a read position,
 * the twin of PHP `Log_Position` (ADR-30), held to it by
 * `tests/fixtures/log-positions.json`.
 *
 * A position is `<segment>:<offset>`, the segment-less `:<offset>` of a file
 * source whose generation is not known yet, or a word the reader resolves
 * for itself. A record's ID breadcrumb is the same grammar carrying the
 * record's length. Every number is a canonical decimal.
 */

/** `Log_Position::WORDS`, the seeks a reader resolves for itself. */
const WORDS = new Set( [ 'start', 'recent', 'end' ] );

/** `Core::canonical_decimal()`'s grammar: no sign, no padding, no base. */
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/**
 * One field as a number, or null when it is no canonical decimal or would
 * lose precision.
 *
 * @param {string} field A position field.
 * @return {?number} The number, or null.
 */
function decimal( field ) {
	if ( ! DECIMAL.test( field ) ) {
		return null;
	}
	const n = Number( field );
	return Number.isSafeInteger( n ) ? n : null;
}

/**
 * Write a position, or with a length, a record's breadcrumb. A segment that
 * is null or undefined is a generation not known yet, which states the
 * offset alone.
 *
 * @param {?number} segment The segment, or a file source's inode.
 * @param {number}  offset  The next byte to read, or a record's first.
 * @param {?number} length  A record's length; null or undefined for a position.
 * @return {string} `<segment>:<offset>`, `:<offset>`, or either with `:<length>`.
 */
export function formatPosition( segment, offset, length ) {
	const tail = undefined === length || null === length ? '' : `:${ length }`;
	return `${ segment ?? '' }:${ offset }${ tail }`;
}

/**
 * Read a position, or a breadcrumb with its length.
 *
 * @param {*} position A position or breadcrumb, or a word.
 * @return {?({segment?:number,offset:number,length?:number}|string)} The
 *   place, the word, or null for anything else.
 */
export function parsePosition( position ) {
	const text = String( position ?? '' );
	if ( WORDS.has( text ) ) {
		return text;
	}
	const fields = text.split( ':' );
	if ( fields.length < 2 || fields.length > 3 ) {
		return null;
	}
	const segment = '' === fields[ 0 ] ? null : decimal( fields[ 0 ] );
	const offset = decimal( fields[ 1 ] );
	const length = 3 === fields.length ? decimal( fields[ 2 ] ) : null;
	if (
		null === offset ||
		( '' !== fields[ 0 ] && null === segment ) ||
		( 3 === fields.length && null === length )
	) {
		return null;
	}
	const at = null === segment ? { offset } : { segment, offset };
	return null === length ? at : { ...at, length };
}

/**
 * A record's `segment:offset:length` breadcrumb, or null when an ID is
 * anything else, as PHP `Log_Position::crumb()` reads one.
 *
 * @param {*} id A record's Message ID.
 * @return {?{segment:number,offset:number,length:number}} The breadcrumb.
 */
export function parseCrumb( id ) {
	const at = parsePosition( 'string' === typeof id ? id : '' );
	if (
		! at ||
		'object' !== typeof at ||
		undefined === at.segment ||
		undefined === at.length
	) {
		return null;
	}
	return { segment: at.segment, offset: at.offset, length: at.length };
}
