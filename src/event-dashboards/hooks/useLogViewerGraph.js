/**
 * useLogViewerGraph — the Log Viewer's graph: one stream over the
 * log its picker names, the polled catalog it picks from, and its paused
 * single step.
 *
 * The graph, the pause/visibility gate and the recorded reopen target are the
 * shared `useStreamGraph`. The catalog is `list_logs` on the `raw-logs` CI,
 * POLLED as a batched-poll slice, so a refusal at mount, a session that
 * expired while the tab slept, and a Reset Graph rebuild all recover on the
 * next tick without a loader of their own. It lists every partition dir under
 * `logs`, `offsets` and `deadletter`, then every registry source as
 * `sources/<name>`. A source streams on the same `/messages/stream`, its rows
 * the raw lines of a log FILE or segmented Log rather than packed envelopes,
 * and steps through the same `read_message`.
 */

import { useCallback, useEffect } from '@wordpress/element';
import {
	useStreamGraph,
	useSteppedRead,
	useLogCatalog,
} from '@newspack-nodes/shared/hooks/useStreamGraph';
import { views } from '../nodes/register';

/** The service CI carrying `list_logs`, `dump_log` and `read_message`. */
const RAW_LOGS_CI = 'raw-logs';

/** Names every node this graph owns: `<PREFIX>:stream` and `:view`. */
const PREFIX = 'log-viewer';

/** The group every command the Log Viewer sends belongs to. */
export const GROUP = 'log-viewer';

/**
 * Mount the Log Viewer's graph. The whole catalog goes to the view,
 * which owns the selection; only the view's FIRST pick opens a stream.
 *
 * @return {{ selectLog: (log: string) => void, setPaused: (paused: boolean) => void, seek: Function, step: () => void, clear: () => void, setFilter: (term: string) => void }}
 *   Control callbacks for the thin React view (the view's own state is read via
 *   useNodeField): `selectLog( log )` re-points the stream at a partition,
 *   `setPaused( paused )` gates it, `seek( log, positions, source )` switches
 *   between follow and browse, `step()` delivers one record while paused, and
 *   `clear()` empties the ring. Reset Graph is driven by a
 *   `Core.bumpGraphGeneration()` bump — mountExospine subscribes this reused
 *   mount's rebuild to it.
 */
export function useLogViewerGraph() {
	// The subscription is CHOSEN: nothing opens until the catalog picks.
	const graph = useStreamGraph( {
		prefix: PREFIX,
		viewClass: views.LogViewerView,
	} );
	const { viewRef, control, resubscribe, seek, setPaused, setFilter, clear } =
		graph;
	const step = useSteppedRead( {
		graph,
		group: GROUP,
		ci: RAW_LOGS_CI,
		command: 'read_message',
	} );
	const logs = useLogCatalog( {
		prefix: PREFIX,
		group: GROUP,
		ci: RAW_LOGS_CI,
		command: 'list_logs',
	} );

	// Record the pick in the view; resubscribe re-opens (tail) if active.
	const selectLog = useCallback(
		( log ) => {
			control( { action: 'select', log } );
			resubscribe( [ log ], null );
		},
		[ control, resubscribe ]
	);

	// Only the DEFAULT opens, so a later catalog cannot yank a Replay.
	useEffect( () => {
		const view = viewRef.current;
		if ( ! view || ! logs.length ) {
			return;
		}
		const hadSelection = Boolean( view.selected );
		control( { action: 'logs', logs } );
		if ( ! hadSelection && view.selected ) {
			resubscribe( [ view.selected ], null );
		}
	}, [ logs, control, resubscribe, viewRef ] );

	return { selectLog, setPaused, seek, step, clear, setFilter };
}
