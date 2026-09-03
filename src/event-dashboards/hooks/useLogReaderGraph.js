/**
 * useLogReaderGraph — the shared spine of the two durable log-reading
 * dashboards, the Partition Viewer and the Log Viewer.
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

/** The Log Viewer's SSE route; omitting it opens `/messages/stream`. */
const LOG_STREAM_ENDPOINT = 'newspack-nodes/v1/log/stream';

/**
 * The Log Viewer catalog's arguments. `sources` is a reserved `taillog` form
 * answering with the registry as struct rows, where the bare verb renders a
 * table for a human. The slice takes its arguments as a fire-time getter, so
 * even a fixed list is a function.
 *
 * @return {string[]} The verb's arguments.
 */
const SOURCES_ARGS = () => [ 'sources' ];

/** The service CI carrying `list_logs`, `log_status` and `read_message`. */
const RAW_LOGS_CI = 'raw-logs';

/**
 * The Log Viewer's paused single-step read. `taillog` is an interpreter
 * builtin, so it names no CI, and it takes a SUB-VERB, so `subjectOf` reads
 * args[1]: the reply is addressed by its subject (ADR-7), and the subject of
 * `read <source> <position>` is not the first token.
 *
 * @type {{command: string, argsFor: (sub: string, position: string) => string[], subjectOf: (args: string[]) => string}}
 */
const LOGVIEWER_STEP_READ = {
	command: 'taillog',
	argsFor: ( sub, position ) => [ 'read', sub, position ],
	subjectOf: ( args ) => args[ 1 ],
};

/**
 * The Partition Viewer's paused single-step read. `read_message <log>
 * <position>` carries its subject at args[0], which is the shape both
 * `useSteppedRead` defaults already assume, so it declares neither.
 *
 * @type {{ci: string, command: string}}
 */
const PARTITION_STEP_READ = { ci: RAW_LOGS_CI, command: 'read_message' };

/**
 * Declare the shared graph, poll its catalog, and own every control the two
 * dashboards share.
 *
 * @param {Object} opts            Everything the two dashboards differ in.
 * @param {string} opts.prefix     Names every node this graph owns:
 *                                 `<prefix>:link`, `:stream`, `:view`, the
 *                                 `<prefix>:list:*` catalog slice and the
 *                                 `<prefix>:read:*` stepped read.
 * @param {any}    opts.viewClass  The view-model node's class, handed over
 *                                 rather than named (ADR-16).
 * @param {string} [opts.endpoint] SSE endpoint override; omit for
 *                                 `/messages/stream`.
 * @param {Object} opts.catalog    `{ command, argsFn, target }` for the
 *                                 polled catalog slice.
 * @param {Object} opts.stepRead   `{ ci, command, argsFor, subjectOf }` for the
 *                                 one-record read behind the paused step.
 * @return {{ catalog: Array, viewRef: Object, control: Function, select: (log: string) => void, seek: Function, resubscribe: Function, setPaused: (paused: boolean) => void, step: () => void, setFilter: (term: string) => void, clear: () => void }}
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

/**
 * The source a fresh Log Viewer opens. Prefer the first AVAILABLE row so the
 * first paint carries lines; fall back to the first listed so a registry with
 * nothing readable still names a selection for the picker.
 *
 * @param {Array<{name:string,available:boolean}>} sources The catalog rows.
 * @return {string} The chosen name, or '' when the catalog is empty.
 */
function defaultSourceName( sources ) {
	const first = sources.find( ( s ) => s.available ) ?? sources[ 0 ];
	return first?.name ?? '';
}

/**
 * Mount the Log Viewer's graph: `/log/stream` over one registry log source,
 * catalogued by `taillog sources`. It picks a default the first time a catalog
 * arrives with nothing selected, and never re-picks.
 *
 * @return {{ selectSource: (name: string) => void, setPaused: (paused: boolean) => void, seek: (name: string, positions: ?Object, source?: Object) => void, sources: Array, step: () => void, clear: () => void, setFilter: (term: string) => void }}
 *   Control callbacks and the source catalog (name, mode, availability and
 *   segments) the picker and the segment sidebar render from. The catalog
 *   keeps itself fresh, being a poll; `step` (paused only) delivers one record
 *   from the cursor, and `clear` empties the ring.
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
	 * Reposition the source and set the view mode. Live tail (null positions)
	 * follows; Replay (positions) captures the source's live boundary for the
	 * Replay→Live flip via `browseControl()` — newest segment for a segmented
	 * source, byte size (null segment) for a file, `follow` for an empty one.
	 *
	 * The boundary comes from the row the CALLER holds, synchronously, and is
	 * approximate either way: the head segment keeps growing while the read is
	 * in flight, and the `taillog sources` poll is the only thing that
	 * freshens the row. The Log Viewer mounts no rail refresh of its own, so a
	 * rotation is not caught until the next poll.
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
 * Mount the Partition Viewer's graph: `/messages/stream` over one partition
 * directory, catalogued by `list_logs`. The whole catalog goes to the view,
 * which owns the selection; only the view's FIRST pick opens a stream.
 *
 * @return {{ selectLog: (log: string) => void, setPaused: (paused: boolean) => void, seek: Function, step: () => void, clear: () => void, setFilter: (term: string) => void }}
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
