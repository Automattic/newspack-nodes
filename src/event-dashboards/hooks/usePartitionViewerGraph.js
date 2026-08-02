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
 *                        heartbeat. `.client` is the injected CommandClient.)
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
 * the soft nodes can be torn down + rebuilt on `reinit()` ("Reset Graph"). On
 * (re)build the hook fires `list_logs` through the link's HttpOut to populate the
 * dropdown, then (re)opens the stream against the default-selected log via
 * `link.setSubscribe`. `selectLog` re-points the link at the new log;
 * `link.setSubscribe` already does close→resubscribe→reopen.
 */

import { ensureSession } from '../../runtime/command-auth';
import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import useReconcile from '@newspack-nodes/shared/hooks/useReconcile';
import { mountExospine } from '../../runtime/exospine';
import { useGatedSubscription } from './useGatedSubscription';
import { CommandClient } from '../../runtime/command-client';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	ID,
	VALUE,
	TM_STRUCT,
} from '../../runtime/message';
import '../nodes/register';
import makeOpId from '@newspack-nodes/shared/utils/makeOpId';

// The RemoteLink node, the inspectable stream Tee, and the view-model node.
const LINK = 'partition:link';
const TEE = 'partition:stream';
const VIEW = 'partition:view';

// TM_STRUCT control message routed by the view's fill() on action; FROM=VIEW.
const controlMsg = ( value ) => {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ FROM ] = VIEW;
	m[ VALUE ] = value;
	return m;
};

// raw-logs: the view mints; TO/ID stamped after (neither is signed).
function rawLogsCommand( view, id, verb, args = [] ) {
	const m = view.command( verb, args );
	if ( null === m ) {
		return null; // unauthenticated; re-auth is under way
	}
	m[ TO ] = 'raw-logs';
	m[ ID ] = id;
	return m;
}

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to the link's
 *                                      HttpOut; defaults to a freshly-constructed
 *                                      CommandClient.
 * @return {{ selectLog: Function, setPaused: Function }} Control callbacks for
 *   the thin React view (the view's own state is read via useNodeState). Reset
 *   Graph is driven by a `Core.bumpGraphGeneration()` bump — mountExospine
 *   subscribes this reused mount's rebuild to it.
 */
export function usePartitionViewerGraph( opts = {} ) {
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Live node handles for the control callbacks (stable across renders).
	const linkRef = useRef( null );
	const viewRef = useRef( null );

	// One-record fetch behind the paused single-step (reply → VIEW future).
	const fetchMessage = useCallback( ( sub, position ) => {
		const view = viewRef.current;
		const link = linkRef.current;
		if ( ! view || ! link ) {
			return Promise.reject( new Error( 'graph not ready' ) );
		}
		const id = makeOpId( 'partition-op' );
		const future = new Promise( ( resolve, reject ) => {
			view.replies.add( id, resolve, reject );
		} );
		const m = rawLogsCommand( view, id, 'read_message', [ sub, position ] );
		if ( null === m ) {
			return Promise.reject( new Error( 'not authenticated' ) );
		}
		link.send( m );
		return future.then( ( payload ) =>
			payload && 'object' === typeof payload ? payload : null
		);
	}, [] );

	// Pause/visibility gating + the record-then-reopen subscription control.
	const { isPausedRef, resubscribe, setPaused, step } = useGatedSubscription(
		{
			linkRef,
			viewRef,
			fetchMessage,
		}
	);

	// So the reconciled catalog fetch stays a stable, dependency-free callback.
	const resubscribeRef = useRef( resubscribe );
	resubscribeRef.current = resubscribe;

	// Bumped per (re)build so the view rebinds; monotonic, not a boolean latch.
	const [ , bumpBuild ] = useState( 0 );

	useEffect( () => {
		// Soft view-nodes; mountExospine snapshots Core for reinit() rebuild.
		const build = ( { interpreter } ) => {
			// ONE RemoteLink; baseUrl/nonce come from the global, not tokens.
			const link = interpreter.makeNode( 'RemoteLink', LINK, [
				'raw-logs',
			] );
			// Pass-through stream Tee; copies frames to the view.
			link.target = TEE;
			link.client =
				optsRef.current.commandClient || CommandClient.fromGlobal();

			const tee = interpreter.makeNode( 'Tee', TEE );
			tee.connectNode( VIEW );

			// View-model node; envelope-to-row shaping inlined in fill().
			const view = interpreter.makeNode( 'PartitionViewerView', VIEW );

			linkRef.current = link;
			viewRef.current = view;

			// Re-publish a surviving pause to the fresh view on reinit.
			if ( isPausedRef.current ) {
				view.fill( controlMsg( { action: 'pause', paused: true } ) );
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
	const selectLog = ( log ) => {
		viewRef.current?.fill( controlMsg( { action: 'select', log } ) );
		resubscribe( [ log ], null );
	};

	// @longform
	// The catalog was fetched inline in the graph build, its failure
	// swallowed as "dropdown stays empty" — so a refusal at mount, or a session
	// that expired while the tab slept, left the partition list blank until a
	// reload. Extracted here so it can be held as reconciled state; its
	// not-ready rejection doubles as the gate, so the loop simply keeps trying
	// until the exospine graph has mounted.
	const fetchLogs = useCallback( () => {
		const view = viewRef.current;
		const link = linkRef.current;
		if ( ! view || ! link ) {
			return Promise.reject( new Error( 'graph not ready' ) );
		}
		const listId = makeOpId( 'partition-op' );
		const listFuture = new Promise( ( resolve, reject ) => {
			view.replies.add( listId, resolve, reject );
		} );
		// After the session lands: mount races /auth.
		ensureSession().then( () => {
			const m = rawLogsCommand( view, listId, 'list_logs' );
			if ( null !== m && viewRef.current === view ) {
				link.send( m );
			}
		} );
		return listFuture.then( ( logs ) => {
			if ( ! Array.isArray( logs ) || 0 === logs.length ) {
				return logs;
			}
			// Push the catalog into the view (defaults selected).
			view.fill( controlMsg( { action: 'logs', logs } ) );
			const selected = view.setStateCache?.view?.selected;
			// Record the default; open only while active.
			if ( selected ) {
				resubscribeRef.current( [ selected ], null );
			}
			return logs;
		} );
	}, [] );

	useReconcile( { load: fetchLogs } );

	// Fetch a log's segment metadata (log_status); stable for a fetch effect.
	const fetchLogStatus = useCallback( ( log ) => {
		const view = viewRef.current;
		const link = linkRef.current;
		if ( ! view || ! link ) {
			return Promise.reject( new Error( 'graph not ready' ) );
		}
		const id = makeOpId( 'partition-op' );
		const future = new Promise( ( resolve, reject ) => {
			view.replies.add( id, resolve, reject );
		} );
		const m = rawLogsCommand( view, id, 'log_status', [ log ] );
		if ( null === m ) {
			return Promise.reject( new Error( 'not authenticated' ) );
		}
		link.send( m );
		return future;
	}, [] );

	// Set the view mode; resubscribe re-opens if active (mode rides control).
	const seek = useCallback(
		( log, positions, end = null ) => {
			viewRef.current?.fill(
				controlMsg(
					positions
						? {
								action: 'browse',
								endSegment: end?.segment ?? null,
								endOffset: end?.offset ?? 0,
						  }
						: { action: 'follow' }
				)
			);
			resubscribe( [ log ], positions );
		},
		[ resubscribe ]
	);

	return { selectLog, setPaused, fetchLogStatus, seek, step };
}
