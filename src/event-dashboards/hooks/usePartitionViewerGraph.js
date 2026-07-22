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

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine } from '../../runtime/exospine';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { CommandClient } from '../../runtime/command-client';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	ID,
	VALUE,
	TM_COMMAND,
	TM_STRUCT,
} from '../../runtime/message';
import '../nodes/register';

// The RemoteLink node, the inspectable stream Tee, and the view-model node.
const LINK = 'partition:link';
const TEE = 'partition:stream';
const VIEW = 'partition:view';

// Monotonic per-hook-instance ID counter for the list_logs correlator.
let nextOpId = 0;
function makeOpId() {
	nextOpId += 1;
	return `partition-op-${ Date.now() }-${ nextOpId }`;
}

// TM_STRUCT control message routed by the view's fill() on action; FROM=VIEW.
const controlMsg = ( value ) => {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ FROM ] = VIEW;
	m[ VALUE ] = value;
	return m;
};

// list_logs TM_COMMAND, FROM=partition:view so its reply (TO=VIEW) routes back.
function buildListCommand( id ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = VIEW;
	m[ TO ] = 'raw-logs';
	m[ ID ] = id;
	m[ VALUE ] = { name: 'list_logs', arguments: [] };
	return m;
}

// log_status TM_COMMAND for one log, correlated like list_logs (reply → VIEW).
function buildStatusCommand( id, log ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = VIEW;
	m[ TO ] = 'raw-logs';
	m[ ID ] = id;
	m[ VALUE ] = { name: 'log_status', arguments: [ log ] };
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

	// A hidden tab throttles the heartbeat; gate the stream on visibility.
	const isPageVisible = usePageVisibility();

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

			// Re-render so useNodeState re-subscribes to the new view.
			bumpBuild( ( n ) => n + 1 );

			// Fire list_logs; its reply opens the stream on the default.
			const listId = makeOpId();
			const listFuture = new Promise( ( resolve, reject ) => {
				view.replies.add( listId, resolve, reject );
			} );
			link.send( buildListCommand( listId ) );
			listFuture
				.then( ( logs ) => {
					if ( ! Array.isArray( logs ) || 0 === logs.length ) {
						return;
					}
					// Push the catalog into the view (defaults selected).
					view.fill( controlMsg( { action: 'logs', logs } ) );
					const selected = view.setStateCache?.view?.selected;
					if ( selected ) {
						link.setSubscribe( [ selected ] );
					}
				} )
				.catch( () => {
					// list_logs failure is silent; dropdown stays empty.
				} );

			// Tear down the RemoteLink before the exospine teardown.
			return () => {
				link.removeNode();
				linkRef.current = null;
				viewRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Visibility gate: close while hidden, reopen the selected log on refocus.
	useEffect( () => {
		const link = linkRef.current;
		if ( ! link ) {
			return;
		}
		if ( isPageVisible ) {
			const selected = viewRef.current?.setStateCache?.view?.selected;
			if ( selected ) {
				// Resume from last offset, not a tail-seek dropping lines.
				link.setSubscribe( [ selected ], link.resumePositions() );
			}
		} else {
			link.close();
		}
	}, [ isPageVisible ] );

	// selectLog: view sets the selection; the link re-opens for the new log.
	const selectLog = ( log ) => {
		const view = viewRef.current;
		const link = linkRef.current;
		if ( view ) {
			view.fill( controlMsg( { action: 'select', log } ) );
		}
		if ( link ) {
			link.setSubscribe( [ log ] );
		}
	};

	const setPaused = ( paused ) => {
		if ( viewRef.current ) {
			viewRef.current.fill( controlMsg( { action: 'pause', paused } ) );
		}
	};

	// Fetch a log's segment metadata (log_status); stable for a fetch effect.
	const fetchLogStatus = useCallback( ( log ) => {
		const view = viewRef.current;
		const link = linkRef.current;
		if ( ! view || ! link ) {
			return Promise.reject( new Error( 'graph not ready' ) );
		}
		const id = makeOpId();
		const future = new Promise( ( resolve, reject ) => {
			view.replies.add( id, resolve, reject );
		} );
		link.send( buildStatusCommand( id, log ) );
		return future;
	}, [] );

	// Reposition the stream: null tails; a positions seed seeks.
	const seek = useCallback( ( log, positions ) => {
		if ( linkRef.current ) {
			linkRef.current.setSubscribe( [ log ], positions );
		}
	}, [] );

	return { selectLog, setPaused, fetchLogStatus, seek };
}
