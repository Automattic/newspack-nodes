/**
 * publishSkippedLines — publish a stream graph's skipped-line count as the
 * page's `_stream` publishes each graph's share of its SseIn's: in its
 * `unparseableByTarget` field, under the graph's `<prefix>:stream`.
 *
 * A view test that stubs its stream hook builds no backbone, so nothing holds
 * `_stream`; this registers a bare link under it. Against a mounted graph it
 * publishes on the link already there.
 */

/* eslint-env jest */
import { Core, RemoteLinkNode, reservedNames } from '@newspack-nodes/runtime';

/**
 * Publish `count` as the share of the graph whose records go to `name`.
 *
 * @param {string} name  The graph's stream node, as it rides the link.
 * @param {number} count Lines the stream skipped.
 * @return {Object} The link publishing it.
 */
export function publishSkippedLines( name, count ) {
	let link = Core.node( reservedNames.STREAM );
	if ( ! link ) {
		link = new RemoteLinkNode();
		link.name = reservedNames.STREAM;
	}
	link.setField( 'unparseableByTarget', {
		...link.unparseableByTarget,
		[ name ]: count,
	} );
	return link;
}
