/**
 * useRawLogsGraph — mounts the Raw Logs dashboard node graph onto the canonical
 * rule-#2 backbone (`_command_interpreter → _router`) using a SINGLE substrate
 * `RemoteLink` node instead of hand-wiring three I/O boundary nodes:
 *
 *   rawlogs:link        (RemoteLink — composes + registers three children:
 *                        `rawlogs:link:sse-in` (SseIn — EventSource ingress),
 *                        `rawlogs:link:http` (HttpOut — POST /command boundary),
 *                        `rawlogs:link:heartbeat` (Heartbeat — slot keep-alive),
 *                        and wires the `connected → slot` bridge to its own
 *                        heartbeat. `.client` is the injected CommandClient.)
 *
 * Plus the single dashboard view-model node:
 *
 *   rawlogs:view        (the view-model node React reads; envelope→row shaping
 *                        is inlined here — the former `rawlogs:route` and
 *                        `rawlogs:transform` chain is gone)
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

import { useEffect, useRef, useState } from '@wordpress/element';
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

// The single RemoteLink node and the dashboard view-model node.
const LINK = 'rawlogs:link';
const VIEW = 'rawlogs:view';

// Monotonic per-hook-instance ID counter for the list_logs correlator.
let nextOpId = 0;
function makeOpId() {
	nextOpId += 1;
	return `rawlogs-op-${ Date.now() }-${ nextOpId }`;
}

// Build a TM_STRUCT control message the view's fill() routes on its `action`.
// FROM=VIEW like its sibling commands — it's the view's own control signal.
const controlMsg = ( value ) => {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ FROM ] = VIEW;
	m[ VALUE ] = value;
	return m;
};

// Build the list_logs TM_COMMAND, FROM=`rawlogs:view` so the reply (TO=VIEW)
// routes back to the view by TO. Routed out through the link's HttpOut to the
// request-scope `raw-logs` CI.
function buildListCommand( id ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = VIEW;
	m[ TO ] = 'raw-logs';
	m[ ID ] = id;
	m[ VALUE ] = { name: 'list_logs', arguments: '' };
	return m;
}

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to the link's
 *                                      HttpOut; defaults to a freshly-constructed
 *                                      CommandClient.
 * @return {{ selectLog: Function, setPaused: Function }} Control callbacks for
 *   the thin React view (the view's own state is read via useNodeState). Reset
 *   Graph is driven by the overlay via `Core.reinit`, stashed by mountExospine.
 */
export function useRawLogsGraph( opts = {} ) {
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Live node handles for the control callbacks (stable across renders).
	const linkRef = useRef( null );
	const viewRef = useRef( null );

	// A long-hidden tab throttles the heartbeat TIMER, so the SSE slot TTLs out and
	// the stream dies. Gate the stream on visibility (same pattern as the topology
	// console + dashboards): close while hidden, reopen the selected log on refocus.
	const isPageVisible = usePageVisibility();

	// Bumped on every (re)build so a consumer re-renders and its useNodeState
	// rebinds to the freshly-registered view node. A monotonic counter, not a
	// boolean latch — reinit()'s second build must still force a render.
	const [ , bumpBuild ] = useState( 0 );

	useEffect( () => {
		// The soft view-nodes the backbone clips onto. mountExospine snapshots
		// Core around this so reinit() removes exactly these and rebuilds them.
		const build = ( { interpreter } ) => {
			const data =
				( typeof window !== 'undefined' && window.NewspackNodesData ) ||
				{};
			const baseUrl = data.restUrl || '/wp-json/';
			const nonce = data.nonce || '';

			// ONE RemoteLink composes the SseIn + HttpOut + Heartbeat children and
			// the `connected → slot` bridge. The positional `arguments` carry a
			// placeholder subscribe (no log selected yet) plus baseUrl/nonce; the
			// real subscription is set via setSubscribe before the stream opens, so
			// the placeholder never reaches an EventSource.
			const link = interpreter.makeNode(
				'RemoteLink',
				LINK,
				`raw-logs ${ baseUrl } ${ nonce }`
			);
			link.target = VIEW;
			link.client =
				optsRef.current.commandClient ||
				new CommandClient( { baseUrl, nonce } );

			// View-model node — envelope→row shaping is inlined into its fill().
			const view = interpreter.makeNode( 'RawLogsView', VIEW );

			linkRef.current = link;
			viewRef.current = view;

			// Re-render so useNodeState re-subscribes to the freshly-mounted view.
			bumpBuild( ( n ) => n + 1 );

			// Fire list_logs through the link's HttpOut. The reply (TO=VIEW) routes
			// back to the view; captured via the view's pending Map, then fed back
			// as `{action:'logs',logs}` and the stream opens on the default log.
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
					// Push the catalog into the view (sets the dropdown + defaults
					// `selected` to logs[0].key).
					view.fill( controlMsg( { action: 'logs', logs } ) );
					const selected = view.setStateCache?.view?.selected;
					if ( selected ) {
						link.setSubscribe( [ selected ] );
					}
				} )
				.catch( () => {
					// list_logs failure is silent — the dropdown stays empty; the
					// reconnect banner / per-request error surface handles the rest.
				} );

			// Tear down the RemoteLink (closes its stream + removes all three
			// children) before the exospine removes the rest.
			return () => {
				link.removeNode();
				linkRef.current = null;
				viewRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Visibility gate: close the stream while hidden (the slot TTLs out anyway),
	// reopen the currently-selected log on refocus. The initial open is driven by
	// the list_logs reply above, so this no-ops until a log is selected.
	useEffect( () => {
		const link = linkRef.current;
		if ( ! link ) {
			return;
		}
		if ( isPageVisible ) {
			const selected = viewRef.current?.setStateCache?.view?.selected;
			if ( selected ) {
				// Refocus resumes from the last seen offset (replays only the lines
				// emitted while hidden), not a blind tail-seek that drops them.
				link.setSubscribe( [ selected ], link.resumePositions() );
			}
		} else {
			link.close();
		}
	}, [ isPageVisible ] );

	// selectLog: the view clears+sets the selection; the link re-opens for the new log.
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

	return { selectLog, setPaused };
}
