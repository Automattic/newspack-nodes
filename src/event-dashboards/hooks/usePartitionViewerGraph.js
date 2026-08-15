/**
 * usePartitionViewerGraph — mounts the Partition Viewer dashboard node graph onto the canonical
 * rule-#2 backbone (`_command_interpreter → _router`) using a SINGLE substrate
 * `RemoteLink` node instead of hand-wiring three I/O boundary nodes:
 *
 *   partition:link        (RemoteLink — composes + registers three children:
 *                        `partition:link:sse-in` (SseIn — EventSource ingress),
 *                        `partition:link:http` (HttpOut — POST /command boundary),
 *                        `partition:link:heartbeat` (Heartbeat — slot keep-alive),
 *                        and wires the `connected → slot` bridge to its own
 *                        heartbeat. `.client` is the injected transport.)
 *
 * Plus the single dashboard view-model node:
 *
 *   partition:view        (the view-model node React reads; envelope→row shaping
 *                        is inlined here — the former `partition:route` and
 *                        `partition:transform` chain is gone)
 *
 * EVERY node sinks into the interpreter; flow is steered ONLY by each node's `target`.
 *
 * The graph build is handed to `mountExospine( build )`, which snapshots Core so
 * the soft nodes can be torn down + rebuilt on `reinit()` ("Reset Graph"). The
 * catalog is POLLED, and the default selection follows whatever it publishes:
 * a rebuild simply asks again on the next tick and re-opens the stream. Every
 * reopen goes through `resubscribe`, which RECORDS the target while paused or
 * hidden rather than reviving a closed stream.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine } from '../../runtime/exospine';
import { browseControl } from '../../shared/nodes/seekTracker';
import { useGatedSubscription } from './useGatedSubscription';
import '../nodes/register';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import { useNodeState } from '../../runtime/react';
import { controlMsg } from '../../shared/helpers/controlMsg';
import { egressPath } from '@newspack-nodes/shared/helpers/egressPath';

// The RemoteLink node, the inspectable stream Tee, and the view-model node.
const LINK = 'partition:link';
const TEE = 'partition:stream';
const VIEW = 'partition:view';
// Three reads, three nodes; each reply lands on the one that asked.
const READ_NODE = 'partition:read';
const LIST_NODE = 'partition:list';
const STATUS_NODE = 'partition:status';
const LIST_VIEW = 'partition:list:view';

/** Partitions come and go slowly; the dropdown does not need every tick. */
const CATALOG_POLL_MS = 10000;

const EMPTY_LOGS = [];
const RAW_LOGS_CI = 'raw-logs';
// Placeholder subscription the catalog repoints; NOT RAW_LOGS_CI.
const SUBSCRIBE_PLACEHOLDER = 'raw-logs';

/**
 * @return {{ selectLog: Function, setPaused: Function, fetchLogStatus: Function, logStatus: { seq: number, log: ?string, result: ?Object }, seek: Function, step: () => void, clear: () => void, setFilter: (term: string) => void }}
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
	// Live node handles for the control callbacks (stable across renders).
	const linkRef = useRef( null );
	const viewRef = useRef( null );

	const target = egressPath( RAW_LOGS_CI );

	// One-record read behind the paused single-step; its own node.
	const stepRead = useCommandOnce( {
		ci: RAW_LOGS_CI,
		command: 'read_message',
		scope: READ_NODE,
	} );
	const { run: runStep } = stepRead;
	const requestStep = useCallback(
		( sub, position ) => runStep( [ sub, position ] ),
		[ runStep ]
	);

	// Segment metadata for the rail, by partition; the answer names the log.
	const status = useCommandOnce( {
		ci: RAW_LOGS_CI,
		command: 'log_status',
		scope: STATUS_NODE,
		retry: true,
	} );
	const { run: runStatus } = status;
	const fetchLogStatus = useCallback(
		( log ) => runStatus( [ log ] ),
		[ runStatus ]
	);

	// Pause/visibility gating + the record-then-reopen subscription control.
	const { isPausedRef, resubscribe, setPaused, step } = useGatedSubscription(
		{
			linkRef,
			viewRef,
			requestStep,
			stepAnswer: stepRead,
		}
	);

	// Bumped per (re)build so the view rebinds; monotonic, not a boolean latch.
	const [ , bumpBuild ] = useState( 0 );

	useEffect( () => {
		// Soft view-nodes; mountExospine snapshots Core for reinit() rebuild.
		const build = ( { interpreter } ) => {
			// ONE RemoteLink; baseUrl/nonce come from the global, not tokens.
			const link = interpreter.makeNode( 'RemoteLink', LINK, [
				SUBSCRIBE_PLACEHOLDER,
			] );
			// Pass-through stream Tee; copies frames to the view.
			link.target = TEE;
			const tee = interpreter.makeNode( 'Tee', TEE );
			tee.connectNode( VIEW );

			// View-model node; envelope-to-row shaping inlined in fill().
			const view = interpreter.makeNode( 'PartitionViewerView', VIEW );
			// The view applies controls from this FROM; records never match.
			view.controlFrom = VIEW;

			linkRef.current = link;
			viewRef.current = view;

			// Re-publish a surviving pause to the fresh view on reinit.
			if ( isPausedRef.current ) {
				view.fill(
					controlMsg( view, { action: 'pause', paused: true } )
				);
			}

			// Re-render so useNodeState re-subscribes to the new view.
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

	// selectLog: view records the pick; resubscribe re-opens (tail) if active.
	const selectLog = useCallback(
		( log ) => {
			viewRef.current?.fill(
				controlMsg( viewRef.current, { action: 'select', log } )
			);
			resubscribe( [ log ], null );
		},
		[ resubscribe ]
	);

	// @longform
	// The partition catalog, POLLED. It used to be fetched inline in the graph
	// build with its failure swallowed as "dropdown stays empty", so a refusal
	// at mount — or a session that expired while the tab slept — left the list
	// blank until a reload. A refusal is now one tick that published nothing.
	useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: `${ LIST_NODE }:fetch`,
				receiver: `${ LIST_NODE }:in`,
				command: 'list_logs',
				view: LIST_VIEW,
				viewClass: 'CatalogListView',
				tee,
				target,
			} ),
		timerName: `${ LIST_NODE }:timer`,
		teeName: `${ LIST_NODE }:tee`,
		intervalMs: CATALOG_POLL_MS,
	} );
	const logs = useNodeState( LIST_VIEW, 'view' )?.items ?? EMPTY_LOGS;

	// Only the DEFAULT opens, so a later catalog cannot yank a Replay.
	useEffect( () => {
		const view = viewRef.current;
		if ( ! view || ! logs.length ) {
			return;
		}
		const hadSelection = Boolean( view.selected );
		view.fill( controlMsg( view, { action: 'logs', logs } ) );
		if ( ! hadSelection && view.selected ) {
			resubscribe( [ view.selected ], null );
		}
	}, [ logs, resubscribe ] );

	// Ingest gate: only matching rows enter the ring from here on.
	const setFilter = useCallback( ( term ) => {
		viewRef.current?.fill(
			controlMsg( viewRef.current, { action: 'filter', term } )
		);
	}, [] );

	// Clear as a control, so the view's ONE reset runs (rows, counter, rate).
	const clear = useCallback( () => {
		viewRef.current?.fill(
			controlMsg( viewRef.current, { action: 'clear' } )
		);
	}, [] );

	// Fetch a log's segment metadata (log_status); stable for a fetch effect.
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
			viewRef.current?.fill(
				controlMsg(
					viewRef.current,
					positions ? browseControl( source ) : { action: 'follow' }
				)
			);
			resubscribe( [ log ], positions );
		},
		[ resubscribe ]
	);

	return {
		selectLog,
		setPaused,
		fetchLogStatus,
		logStatus: {
			seq: status.seq,
			log: status.answeredArgs?.[ 0 ] ?? null,
			result: status.result,
		},
		seek,
		step,
		clear,
		setFilter,
	};
}
