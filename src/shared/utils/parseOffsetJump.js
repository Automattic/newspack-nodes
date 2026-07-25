/**
 * parseOffsetJump — the offset-input grammar shared by every log-stream
 * dashboard: a full message ID (`seg:off[:len]`, length ignored) jumps to
 * that position; a bare offset resolves against the caller's fallback
 * segment (last received, else the browsed one).
 *
 * @param {string}  text            The trimmed input text.
 * @param {?number} fallbackSegment Segment for bare offsets; null = none.
 * @return {?{segment: number, offset: number}} The position, or null.
 */
export default function parseOffsetJump( text, fallbackSegment ) {
	const full = text.match( /^(\d+):(\d+)(?::\d+)?$/ );
	if ( full ) {
		return {
			segment: parseInt( full[ 1 ], 10 ),
			offset: parseInt( full[ 2 ], 10 ),
		};
	}
	if ( /^\d+$/.test( text ) && 'number' === typeof fallbackSegment ) {
		return { segment: fallbackSegment, offset: parseInt( text, 10 ) };
	}
	return null;
}
