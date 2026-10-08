/**
 * publishSkippedLines — publish a stream graph's skipped-line count on its
 * `<prefix>:stream`, as the page's `RemoteLinkNode` publishes each graph's
 * share of its SseIn's.
 *
 * A view test that stubs its stream hook builds no graph, so nothing holds the
 * name the view hands `UnparseableLinesNotice`; this registers a bare node
 * under it. Against a mounted graph it publishes on the node already there.
 */

/* eslint-env jest */
import { Core, Node } from '@newspack-nodes/runtime';

/**
 * Publish `count` as `UNPARSEABLE_LINES` on the node named `name`.
 *
 * @param {string} name  The stream node's registered name.
 * @param {number} count Lines the stream skipped.
 * @return {Object} The node publishing it.
 */
export function publishSkippedLines( name, count ) {
	let node = Core.node( name );
	if ( ! node ) {
		node = new Node();
		node.name = name;
	}
	node.setState( 'UNPARSEABLE_LINES', count );
	return node;
}
