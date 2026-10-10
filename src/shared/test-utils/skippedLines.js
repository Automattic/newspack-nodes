/**
 * publishSkippedLines — publish a stamp's skipped-line count as the page's
 * `_stream` publishes its SseIn's: in its `unparseableByStamp` field.
 *
 * A view test that stubs its stream hook builds no backbone, so nothing holds
 * `_stream`; this registers a bare link under it. Against a mounted graph it
 * publishes on the link already there.
 */

/* eslint-env jest */
import { Core, RemoteLinkNode, reservedNames } from '@newspack-nodes/runtime';

/**
 * Publish `count` as the lines skipped on `stamp`.
 *
 * @param {string} stamp A record stamp, as `splitStamp()` reads it.
 * @param {number} count Lines the stream skipped on it.
 * @return {Object} The link publishing it.
 */
export function publishSkippedLines( stamp, count ) {
	let link = Core.node( reservedNames.STREAM );
	if ( ! link ) {
		link = new RemoteLinkNode();
		link.name = reservedNames.STREAM;
	}
	link.setField( 'unparseableByStamp', {
		...link.unparseableByStamp,
		[ stamp ]: count,
	} );
	return link;
}
