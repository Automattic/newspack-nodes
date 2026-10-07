/**
 * parseOffsetJump — the grammar behind the Jump box `useSegmentBrowse` puts on
 * every log-stream dashboard.
 *
 * The three-part form is a message ID verbatim: `Durable_Reader` stamps
 * `segment:offset:length` into `Message::ID`, so an operator pastes an ID out
 * of a row and lands on that record. `parsePosition()` reads it, so the box
 * takes exactly the positions every other reader takes.
 */

import { parsePosition } from '../../runtime/log-position';

/**
 * Resolve typed input to a seek position.
 *
 * A seek needs only the segment and the offset, so a pasted ID's third field
 * is matched and discarded. A bare offset means "this far into the segment I
 * am reading" and takes the caller's segment; with none to resolve against it
 * is refused, never assumed to mean segment 0, which would seek somewhere the
 * operator did not name. A refusal is null rather than a throw because both
 * callers read it as a verdict: the Jump box shows a refusal where the text
 * was typed, and `useSegmentBrowse` answers one to the box.
 *
 * @param {string}  text            The input text, already trimmed; surrounding whitespace matches neither form.
 * @param {?number} fallbackSegment Segment a bare offset resolves against; null refuses one.
 * @return {?{segment: number, offset: number}} The position, or null when the text is neither form.
 */
export default function parseOffsetJump( text, fallbackSegment ) {
	const at = parsePosition( text );
	if ( undefined !== at?.segment ) {
		return { segment: at.segment, offset: at.offset };
	}
	if ( /^\d+$/.test( text ) && 'number' === typeof fallbackSegment ) {
		return { segment: fallbackSegment, offset: parseInt( text, 10 ) };
	}
	return null;
}
