import { _n, sprintf } from '@wordpress/i18n';
import { useNodeState } from '@newspack-nodes/runtime';

/**
 * The warning a log reader shows when lines it read would not parse and were
 * skipped: the SSE stream, the Overview's consumer rows and an event-logger
 * grep all keep no cursor to replay such a line from, so each skips it and
 * reports the count rather than failing every read until the segment rotates.
 * A count carried and never shown is a skip no one sees, so every page-level
 * view renders its count through here. The aggregator's spoke tiles are the
 * one exception: their count is a per-partition metric, and it sits in the
 * tile's own stat grid beside the heartbeat and HTTP code it is read against.
 *
 * A stream's count needs no threading: hand the notice the node that
 * publishes `UNPARSEABLE_LINES` — a `<prefix>:link` — and it subscribes by
 * name, as every thin view does, so a graph rebuild under that name is
 * followed. A count that arrives in a reply instead goes in as `count`.
 *
 * It wears the canonical `newspack-nodes-banner is-warning` role and declares
 * no appearance of its own. `role="status"` makes it a polite live region, so
 * a count that climbs is announced without interrupting the reader.
 *
 * A view with more than one reader shows one notice per reader, each naming
 * its `source`: two counts summed into one banner say lines were lost but not
 * where, and the per-poll count of a server read does not add to the running
 * count of a stream.
 *
 * @param {Object}  props
 * @param {string}  [props.node]   The stream node publishing `UNPARSEABLE_LINES`.
 * @param {?number} [props.count]  Lines skipped, for a reader with no node; ignored beside `node`. Zero or absent renders nothing.
 * @param {string}  [props.source] What read the lines, for a view with several readers.
 * @return {import('react').ReactElement|null} The notice, or null when nothing was skipped.
 */
export default function UnparseableLinesNotice( { node, count, source } ) {
	const streamed = useNodeState( node, 'UNPARSEABLE_LINES' );
	const skipped = node ? streamed : count;
	if ( ! ( skipped > 0 ) ) {
		return null;
	}
	return (
		<p className="newspack-nodes-banner is-warning" role="status">
			{ source
				? sprintf(
						// translators: 1: the reader, 2: number of log lines skipped.
						_n(
							'%1$s: %2$d line would not parse and was skipped.',
							'%1$s: %2$d lines would not parse and were skipped.',
							skipped,
							'newspack-nodes'
						),
						source,
						skipped
				  )
				: sprintf(
						// translators: %d: number of log lines skipped.
						_n(
							'%d line would not parse and was skipped.',
							'%d lines would not parse and were skipped.',
							skipped,
							'newspack-nodes'
						),
						skipped
				  ) }
		</p>
	);
}
