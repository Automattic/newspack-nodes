/**
 * parseOffsetJump — the grammar behind the Jump box `useSegmentBrowse` puts on
 * every log-stream dashboard.
 *
 * The three-part form is a message ID verbatim: `Durable_Reader` stamps
 * `segment:offset:length` into `Message::ID`, so an operator pastes an ID out
 * of a row and lands on that record.
 */

/**
 * Resolve typed input to a seek position.
 *
 * A seek needs only the segment and the offset, so a pasted ID's third field
 * is matched and discarded. A bare offset means "this far into the segment I
 * am reading" and takes the caller's segment; with none to resolve against it
 * is refused, never assumed to mean segment 0, which would seek somewhere the
 * operator did not name. A refusal is null rather than a throw because the
 * caller runs this on every Enter keypress, where half-typed text has to be a
 * no-op.
 *
 * @param {string}  text            The input text, already trimmed; surrounding whitespace matches neither form.
 * @param {?number} fallbackSegment Segment a bare offset resolves against; null refuses one.
 * @return {?{segment: number, offset: number}} The position, or null when the text is neither form.
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
