/**
 * useLogReaderGraph — the durable log-reading dashboard, and the two built on
 * it: the Partition Viewer and the Log Viewer.
 *
 * The graph, the pause/visibility gate and the recorded reopen target are the
 * shared `useStreamGraph`; what belongs here is the CATALOG the subscription is
 * chosen from. It is POLLED as a batched-poll slice, so a refusal at mount, a
 * session that expired while the tab slept, and a Reset Graph rebuild all
 * recover on the next tick without a loader of their own.
 *
 * The two dashboards differ in what they stream and how a default selection is
 * established, and those differences stay in their own hooks below:
 *
 *   - The Log Viewer's link opens the substrate's `GET /log/stream` (the
 *     `endpoint` override) instead of `/messages/stream`; on the wire the two
 *     are identical (packed `msg` frames, connected/heartbeat, slot pool), and
 *     the source resolves to a `Tail` reader over a log FILE (or segmented Log)
 *     by registry NAME. Its rows are raw log-file lines, not packed partition
 *     envelopes.
 *   - Their catalogs are different verbs: the interpreter builtin `taillog
 *     sources` (empty TO, no service CI) replying with `{ name, path, mode,
 *     available, bytes, segments }` source rows, versus `list_logs` on the
 *     `raw-logs` CI.
 *   - The Log Viewer picks its own default source and never re-picks; the
 *     Partition Viewer hands the whole catalog to its view and lets it choose.
 *   - Only the Log Viewer's `seek` guards against a stale selection.
 */

import { useCallback, useEffect } from '@wordpress/element';
import {
	useStreamGraph,
	useSteppedRead,
	useLogCatalog,
} from '@newspack-nodes/shared/hooks/useStreamGraph';
import { views } from '../nodes/register';
import { egressPath } from '@newspack-nodes/shared/helpers/egressPath';

const LOG_STREAM_ENDPOINT = 'newspack-nodes/v1/log/stream';
const SOURCES_ARGS = () => [ 'sources' ];

// Where `list_logs`, `log_status` and `read_message` live.
const RAW_LOGS_CI = 'raw-logs';

// @longform
// `taillog` is an interpreter builtin, so it has no CI — and it takes a
// SUB-VERB, so the source the reply is ABOUT is not at args[0].
const LOGVIEWER_STEP_READ = {
	command: 'taillog',
	argsFor: ( sub, position ) => [ 'read', sub, position ],
	subjectOf: ( args ) => args[ 1 ],
};
const PARTITION_STEP_READ = { ci: RAW_LOGS_CI, command: 'read_message' };

/**
 * Declare the shared graph, poll its catalog, and own every control the two
 * dashboards share.
 *
 * @param {Object} opts
 * @param {string} opts.prefix     Names every node this graph owns:
 *                                 `<prefix>:link`, `:stream`, `:view` and
 *                                 the `<prefix>:list:*` catalog slice.
 * @param {any}    opts.viewClass  The view-model node's class, handed over
 *                                 rather than named — see `addSliceFetcher`.
 * @param {string} [opts.endpoint] SSE endpoint override; omit for
 *                                 `/messages/stream`.
 * @param {Object} opts.catalog    `{ command, argsFn, target }` for the
 *                                 polled catalog slice.
 * @param {Object} opts.stepRead   `{ ci, command, argsFor, subjectOf }` for the
 *                                 one-record read behind the paused step.
 * @return {{ catalog: Array, viewRef: Object, control: Function, select: Function, seek: Function, resubscribe: Function, setPaused: Function, step: () => void, setFilter: (term: string) => void, clear: () => void }}
 *   The catalog rows, the live view node, and the shared controls.
 */
function useLogReaderGraph( opts ) {
	const { prefix } = opts;
	// The subscription is CHOSEN: nothing opens until the catalog picks.
	const graph = useStreamGraph( {
		prefix,
		subscribe: null,
		viewClass: opts.viewClass,
		endpoint: opts.endpoint,
	} );
	const { viewRef, control, resubscribe, seek, setPaused, setFilter, clear } =
		graph;
	const step = useSteppedRead( { graph, ...opts.stepRead } );

	const catalog = useLogCatalog( { prefix, ...opts.catalog } );

	// Record the pick in the view; resubscribe re-opens (tail) if active.
	const select = useCallback(
		( log ) => {
			control( { action: 'select', log } );
			resubscribe( [ log ], null );
		},
		[ control, resubscribe ]
	);

	return {
		catalog,
		viewRef,
		control,
		select,
		seek,
		resubscribe,
		setPaused,
		step,
		setFilter,
		clear,
	};
}

// Prefer the first available source; else fall back to the first listed.
function defaultSourceName( sources ) {
	const first = sources.find( ( s ) => s.available ) ?? sources[ 0 ];
	return first?.name ?? '';
}

/**
 * @return {{ selectSource: Function, setPaused: Function, seek: Function, sources: Array, step: () => void, clear: () => void, setFilter: (term: string) => void }}
 *   Control callbacks + the source catalog (name/mode/availability/segments)
 *   for the picker and segment sidebar. The catalog keeps itself fresh — it is
 *   a poll — so `step` (paused only) delivers one record from the cursor and
 *   `clear` empties the ring.
 */
export function useLogViewerGraph() {
	const {
		catalog: sources,
		viewRef,
		select,
		seek: graphSeek,
		setPaused,
		step,
		setFilter,
		clear,
	} = useLogReaderGraph( {
		prefix: 'logviewer',
		viewClass: views.LogViewerView,
		endpoint: LOG_STREAM_ENDPOINT,
		catalog: {
			command: 'taillog',
			argsFn: SOURCES_ARGS,
			target: egressPath(),
		},
		stepRead: LOGVIEWER_STEP_READ,
	} );

	// Default ONLY when nothing is selected; a later catalog never overrides.
	useEffect( () => {
		const view = viewRef.current;
		if ( ! view || view.selected || ! sources.length ) {
			return;
		}
		const chosen = defaultSourceName( sources );
		if ( chosen ) {
			select( chosen );
		}
	}, [ sources, select, viewRef ] );

	/**
	 * Reposition the source + set the view mode. Live tail (null positions)
	 * follows; Replay (positions) captures the source's live boundary for the
	 * Replay→Live flip via `browseControl()` — newest segment for a segmented
	 * source, byte size (null segment) for a file, `follow` for an empty one.
	 *
	 * The boundary comes from the row the CALLER holds, synchronously — it is
	 * approximate either way, since the head segment grows while any fresher
	 * read is in flight, and the caller re-catalogs on its own cadence and on
	 * rotation.
	 *
	 * @param {string}  name      The source name to (re)open.
	 * @param {?Object} positions The SSE positions seed; null tails live.
	 * @param {Object}  [source]  The source row (`{segments, bytes}`) to
	 *                            capture the boundary from.
	 */
	const seek = useCallback(
		( name, positions, source ) => {
			// Stale seek: the selection moved on before this ran.
			if ( viewRef.current?.selected !== name ) {
				return;
			}
			graphSeek( name, positions, source );
		},
		[ graphSeek, viewRef ]
	);

	return {
		setFilter,
		selectSource: select,
		setPaused,
		seek,
		sources,
		step,
		clear,
	};
}

/**
 * @return {{ selectLog: Function, setPaused: Function, seek: Function, step: () => void, clear: () => void, setFilter: (term: string) => void }}
 *   Control callbacks for the thin React view (the view's own state is read via
 *   useNodeState): `selectLog( log )` re-points the stream at a partition,
 *   `setPaused( paused )` gates it, `seek( log, positions, source )` switches
 *   between follow and browse, `step()` delivers one record while paused, and
 *   `clear()` empties the ring. Reset Graph is driven by a
 *   `Core.bumpGraphGeneration()` bump — mountExospine subscribes this reused
 *   mount's rebuild to it.
 */
export function usePartitionViewerGraph() {
	const {
		catalog: logs,
		viewRef,
		control,
		select,
		seek,
		resubscribe,
		setPaused,
		step,
		setFilter,
		clear,
	} = useLogReaderGraph( {
		prefix: 'partition',
		viewClass: views.PartitionViewerView,
		catalog: {
			command: 'list_logs',
			target: egressPath( RAW_LOGS_CI ),
		},
		stepRead: PARTITION_STEP_READ,
	} );

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

	return {
		selectLog: select,
		setPaused,
		seek,
		step,
		clear,
		setFilter,
	};
}
