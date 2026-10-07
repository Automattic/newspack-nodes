/**
 * log-position — the one JS writer and the one JS reader of a read position,
 * the twin of PHP `Log_Position` (ADR-30), held to it by
 * `tests/fixtures/log-positions.json`.
 *
 * A position is `<segment>:<offset>`, or the segment-less `:<offset>` of a
 * file source whose generation is not known yet. A record's ID breadcrumb is
 * the same grammar carrying the record's length. Every number is a canonical
 * decimal.
 */

/**
 * `Log_Position::GRAMMAR`: an optional segment, an offset and an optional
 * length, each a canonical decimal — no sign, no padding, no base.
 */
const GRAMMAR = /^(0|[1-9][0-9]*)?:(0|[1-9][0-9]*)(?::(0|[1-9][0-9]*))?$/;

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
 * Read a position, or a breadcrumb with its length, through one anchored
 * match. A number past `Number.MAX_SAFE_INTEGER` names no position.
 *
 * @param {*} position A position or breadcrumb.
 * @return {?{segment?:number,offset:number,length?:number}} The place, or
 *   null for anything else, a seek word included.
 */
export function parsePosition( position ) {
	const fields = GRAMMAR.exec( String( position ?? '' ) );
	if ( ! fields ) {
		return null;
	}
	/** @type {{segment?:number,offset:number,length?:number}} */
	const at = { offset: Number( fields[ 2 ] ) };
	if ( undefined !== fields[ 1 ] ) {
		at.segment = Number( fields[ 1 ] );
	}
	if ( undefined !== fields[ 3 ] ) {
		at.length = Number( fields[ 3 ] );
	}
	return Object.values( at ).every( Number.isSafeInteger ) ? at : null;
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
	return undefined === at?.segment || undefined === at.length
		? null
		: { segment: at.segment, offset: at.offset, length: at.length };
}
