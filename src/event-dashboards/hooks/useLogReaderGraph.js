/**
 * useLogReaderGraph — the durable log-reading dashboard graph, and the two
 * dashboards built on it: the Partition Viewer and the Log Viewer.
 *
 * Both mount the SAME backbone through `mountExospine`, so it is built once
 * here (a single substrate `RemoteLink` → stream `Tee` → view-model node):
 *
 *   <prefix>:link    RemoteLink — composes + registers three children,
 *                    `<prefix>:link:sse-in` (SseIn — EventSource ingress),
 *                    the shared `_http` (HttpOut — POST /command boundary) and
 *                    `_heartbeat` (slot keep-alive), and wires the
 *                    `connected → slot` bridge to that heartbeat.
 *   <prefix>:stream  Pass-through Tee; copies frames to the view, and is where
 *                    a debug-overlay `connect` taps the live stream.
 *   <prefix>:view    The view-model node React reads; envelope→row shaping is
 *                    inlined in its `fill()`.
 *
 * EVERY node sinks into the interpreter; flow is steered ONLY by each node's
 * `target`. The catalog is POLLED as a batched-poll slice, so a refusal at
 * mount, a session that expired while the tab slept, and a Reset Graph rebuild
 * all recover on the next tick without a loader of their own. Every reopen goes
 * through `resubscribe`, which RECORDS the target while paused or hidden rather
 * than reviving a closed stream.
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

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine } from '../../runtime/exospine';
import { browseControl } from '../../shared/nodes/seekTracker';
import { useGatedSubscription } from './useGatedSubscription';
import { views } from '../nodes/register';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import { useNodeState } from '../../runtime/react';
import { controlMsg } from '../../shared/helpers/controlMsg';
import { egressPath } from '@newspack-nodes/shared/helpers/egressPath';

/** Segments, sizes and partitions move slowly; no need for every tick. */
const CATALOG_POLL_MS = 10000;

const EMPTY_CATALOG = [];

const LOG_STREAM_ENDPOINT = 'newspack-nodes/v1/log/stream';
const SOURCES_ARGS = () => [ 'sources' ];

// @longform
// The CI mount and the placeholder subscription share a spelling by accident,
// not by rule: one is where `list_logs` lives, the other is what the link
// subscribes to until the catalog repoints it at a real partition. Keep them
// apart so renaming the mount cannot silently retarget the stream.
const RAW_LOGS_CI = 'raw-logs';
const SUBSCRIBE_PLACEHOLDER = 'raw-logs';
// 'php' is a builtin source placeholder; the catalog repoints it.
const SOURCE_PLACEHOLDER = 'php';

// @longform
// Each paused step's one-record read; `taillog` is a builtin, so it has no CI
// — and it takes a SUB-VERB, so the source is not at args[0]. `subOf` is
// `argsFor` read backwards: the reply echoes the tokens that were sent, and
// declaring the two apart is how the reader guesses at the writer's layout.
const LOGVIEWER_STEP_READ = {
	scope: 'logviewer:read',
	command: 'taillog',
	argsFor: ( sub, position ) => [ 'read', sub, position ],
	subOf: ( args ) => args[ 1 ],
};
const PARTITION_STEP_READ = {
	ci: RAW_LOGS_CI,
	scope: 'partition:read',
	command: 'read_message',
	argsFor: ( sub, position ) => [ sub, position ],
	subOf: ( args ) => args[ 0 ],
};

/**
 * Mount the link → tee → view graph, poll its catalog, and own every control
 * that both dashboards share. See the module docblock for the backbone.
 *
 * @param {Object} opts
 * @param {string} opts.prefix     Names every node this graph owns:
 *                                 `<prefix>:link`, `:stream`, `:view` and
 *                                 the `<prefix>:list:*` catalog slice.
 * @param {any}    opts.viewClass  The view-model node's class, handed over
 *                                 rather than named — see `addSliceFetcher`.
 * @param {string} opts.subscribe  The RemoteLink's placeholder subscription.
 * @param {string} [opts.endpoint] SSE endpoint override; omit for
 *                                 `/messages/stream`.
 * @param {Object} opts.catalog    `{ command, argsFn, target }` for the
 *                                 polled catalog slice.
 * @param {Object} opts.stepRead   `{ ci, command, scope, argsFor, subOf }` for
 *                                 one-record read behind the paused step.
 * @return {{ catalog: Array, viewRef: Object, control: Function, select: Function, resubscribe: Function, setPaused: Function, step: () => void, setFilter: (term: string) => void, clear: () => void }}
 *   The catalog rows, the live view node, and the shared controls.
 */
function useLogReaderGraph( opts ) {
	const { prefix } = opts;
	const linkRef = useRef( null );
	const viewRef = useRef( null );
	// Read live inside the once-only mount + poll builds.
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Pause/visibility gating + the record-then-reopen subscription control.
	const { isPausedRef, resubscribe, setPaused, step } = useGatedSubscription(
		{
			linkRef,
			viewRef,
			stepRead: opts.stepRead,
		}
	);

	// Bumped per (re)build so the view rebinds; monotonic, not a boolean latch.
	const [ , bumpBuild ] = useState( 0 );

	useEffect( () => {
		// Soft view-nodes; mountExospine snapshots Core for reinit() rebuild.
		const build = ( { interpreter } ) => {
			const { viewClass, subscribe, endpoint } = optsRef.current;
			const link = interpreter.makeNode(
				'RemoteLink',
				`${ prefix }:link`,
				[ subscribe ]
			);
			if ( endpoint ) {
				link.endpoint = endpoint;
			}
			link.target = `${ prefix }:stream`;
			const tee = interpreter.makeNode( 'Tee', `${ prefix }:stream` );
			tee.connectNode( `${ prefix }:view` );

			const view = interpreter.makeNode( viewClass, `${ prefix }:view` );
			// The view applies controls from this FROM; records never match.
			view.controlFrom = `${ prefix }:view`;

			linkRef.current = link;
			viewRef.current = view;

			// Re-publish a surviving pause to the fresh view on reinit.
			if ( isPausedRef.current ) {
				view.fill(
					controlMsg( view, { action: 'pause', paused: true } )
				);
			}

			bumpBuild( ( n ) => n + 1 );

			// Tear down the RemoteLink before the exospine teardown.
			return () => {
				link.removeNode();
				linkRef.current = null;
				viewRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
		// Mount once; the shared-hook deps are stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [] );

	// @longform
	// The catalog, POLLED. It used to be fetched inside the graph build with
	// its failure swallowed as "the picker stays empty", so a refusal at mount
	// — or a session that expired while the tab slept — left the dashboard dead
	// with no way back but a reload. A refusal is now one empty tick.
	useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: `${ prefix }:list:fetch`,
				receiver: `${ prefix }:list:in`,
				command: optsRef.current.catalog.command,
				argsFn: optsRef.current.catalog.argsFn,
				view: `${ prefix }:list:view`,
				viewClass: views.CatalogListView,
				tee,
				target: optsRef.current.catalog.target,
			} ),
		timerName: `${ prefix }:list:timer`,
		teeName: `${ prefix }:list:tee`,
		intervalMs: CATALOG_POLL_MS,
	} );
	const catalog =
		useNodeState( `${ prefix }:list:view`, 'view' )?.items ?? EMPTY_CATALOG;

	// The ONE control minter: everything the dashboards drive goes through it.
	const control = useCallback( ( value ) => {
		const view = viewRef.current;
		if ( view ) {
			view.fill( controlMsg( view, value ) );
		}
	}, [] );

	// Record the pick in the view; resubscribe re-opens (tail) if active.
	const select = useCallback(
		( log ) => {
			control( { action: 'select', log } );
			resubscribe( [ log ], null );
		},
		[ control, resubscribe ]
	);

	// Ingest gate: only matching rows enter the ring from here on.
	const setFilter = useCallback(
		( term ) => control( { action: 'filter', term } ),
		[ control ]
	);

	// Clear as a control, so the view's ONE reset runs (rows, counter, rate).
	const clear = useCallback(
		() => control( { action: 'clear' } ),
		[ control ]
	);

	return {
		catalog,
		viewRef,
		control,
		select,
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
		control,
		select,
		resubscribe,
		setPaused,
		step,
		setFilter,
		clear,
	} = useLogReaderGraph( {
		prefix: 'logviewer',
		viewClass: views.LogViewerView,
		subscribe: SOURCE_PLACEHOLDER,
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

	// The poll keeps the rail fresh on its own; nothing to trigger.

	/**
	 * Reposition the source + set the view mode. Live tail (null positions)
	 * follows; Replay (positions) captures the source's live boundary for the
	 * Replay→Live flip via `browseControl()` — newest segment for a segmented
	 * source, byte size (null segment) for a file, `follow` for an empty one.
	 *
	 * The boundary comes from the row the CALLER holds, synchronously. This
	 * used to re-dispatch `taillog sources` for a fresher size, which cost a
	 * round trip on every Replay click and, on rejection, entered replay with
	 * NO boundary — a state the user could only escape by clicking Live. Both
	 * boundaries are approximate anyway: the head segment grows during the
	 * round trip too, and the caller re-catalogs every SEGMENTS_REFRESH_MS and
	 * on rotation. Trading a flip a few seconds early for a hard stuck state
	 * was the wrong side of that trade, and it was the only one of three
	 * consumers making it.
	 *
	 * @param {string}  name      The source name to (re)open.
	 * @param {?Object} positions The SSE positions seed; null tails live.
	 * @param {Object}  [source]  The source row (`{segments, bytes}`) to
	 *                            capture the boundary from.
	 */
	const seek = useCallback(
		( name, positions, source = {} ) => {
			// Stale seek: the selection moved on before this ran.
			if ( viewRef.current?.selected !== name ) {
				return;
			}
			control(
				positions ? browseControl( source ) : { action: 'follow' }
			);
			resubscribe( [ name ], positions );
		},
		[ control, resubscribe, viewRef ]
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
 * @return {{ selectLog: Function, setPaused: Function, fetchLogStatus: Function, logStatus: { log: ?string, result: ?Object }, seek: Function, step: () => void, clear: () => void, setFilter: (term: string) => void }}
 *   Control callbacks for the thin React view (the view's own state is read via
 *   useNodeState): `selectLog( log )` re-points the stream at a partition,
 *   `setPaused( paused )` gates it, `fetchLogStatus( log )` asks for that
 *   partition's segment metadata (answered on `logStatus`, which names the log
 *   it is about), `seek( log, positions, source )` switches between
 *   follow and browse, `step()` delivers one record while paused, and
 *   `clear()` empties the ring. Reset Graph is driven by a
 *   `Core.bumpGraphGeneration()` bump — mountExospine subscribes this reused
 *   mount's rebuild to it.
 */
export function usePartitionViewerGraph() {
	// Segment metadata for the rail, by partition; the answer names the log.
	const status = useCommandOnce( {
		ci: RAW_LOGS_CI,
		command: 'log_status',
		scope: 'partition:status',
		retry: true,
	} );
	const { run: runStatus } = status;
	const fetchLogStatus = useCallback(
		( log ) => runStatus( [ log ] ),
		[ runStatus ]
	);

	const {
		catalog: logs,
		viewRef,
		control,
		select,
		resubscribe,
		setPaused,
		step,
		setFilter,
		clear,
	} = useLogReaderGraph( {
		prefix: 'partition',
		viewClass: views.PartitionViewerView,
		subscribe: SUBSCRIBE_PLACEHOLDER,
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

	/**
	 * Set the view mode; resubscribe re-opens if active (mode rides control).
	 *
	 * @param {string}  log       The partition to (re)open.
	 * @param {?Object} positions The SSE positions seed; null tails live.
	 * @param {Object}  [source]  The source row (`{segments, bytes}`) to
	 *                            capture the replay boundary from.
	 */
	const seek = useCallback(
		( log, positions, source = {} ) => {
			control(
				positions ? browseControl( source ) : { action: 'follow' }
			);
			resubscribe( [ log ], positions );
		},
		[ control, resubscribe ]
	);

	return {
		selectLog: select,
		setPaused,
		fetchLogStatus,
		logStatus: {
			log: status.answeredArgs?.[ 0 ] ?? null,
			result: status.result,
		},
		seek,
		step,
		clear,
		setFilter,
	};
}
