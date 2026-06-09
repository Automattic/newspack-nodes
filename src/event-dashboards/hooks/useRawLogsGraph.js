/**
 * useRawLogsGraph — mounts the Raw Logs dashboard node graph onto the canonical
 * rule-#2 backbone (`_command_interpreter → _router`) using the substrate's
 * I/O boundary nodes — the same ones the topology console uses:
 *
 *   _sse        (SseInNode — EventSource ingress, args `'{log-key} {restUrl} {nonce}'`)
 *   _http       (HttpOut — POST /command boundary; .client = CommandClient)
 *   _heartbeat  (Heartbeat — slot keep-alive; target = `_http/workers`)
 *
 * Plus the single dashboard view-model node:
 *
 *   rawlogs:view        (the view-model node React reads; envelope→row shaping
 *                        is inlined here — the former `rawlogs:route` and
 *                        `rawlogs:transform` chain is gone)
 *
 * EVERY node sinks into the interpreter; flow is steered ONLY by each node's `target`.
 * The bespoke `rawlogs:stream` Node and inlined slot-heartbeat loop are gone —
 * `_sse` owns the EventSource, `_heartbeat` owns the slot poke.
 *
 * The graph build is handed to `mountExospine( build )`, which snapshots Core so
 * the soft nodes can be torn down + rebuilt on `reinit()` ("Reset Graph"). On
 * (re)build the hook fires `list_logs` through `_http` to populate the dropdown,
 * then (re)opens the EventSource against the default-selected log. `selectLog`
 * closes the current source, reassigns `_sse.subscribe`, and reopens.
 *
 * The slot bridge mirrors useConsoleGraph: a `connected`-event subscriber on
 * `_sse` reads `payload.slot` / `.partition` and pushes them into `_heartbeat`.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine } from '../../runtime/exospine';
import usePageVisibility from '../../shared/hooks/usePageVisibility';
import { CommandClient } from '../../runtime/command_client';
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

// The I/O boundary nodes mounted from the substrate runtime.
const SSE = '_sse';
const HTTP = '_http';
const HEARTBEAT = '_heartbeat';
// The dashboard view-model node.
const VIEW = 'rawlogs:view';

// Monotonic per-hook-instance ID counter for the list_logs correlator.
let nextOpId = 0;
function makeOpId() {
	nextOpId += 1;
	return `rawlogs-op-${ Date.now() }-${ nextOpId }`;
}

// Build a TM_STRUCT control message the view's fill() routes on its `action`.
const controlMsg = ( value ) => {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ VALUE ] = value;
	return m;
};

// Build the list_logs TM_COMMAND, FROM=`rawlogs:view` so the reply lands at the
// view (we feed it via a TM_STRUCT `{ action:'logs', logs }` control after a
// short fill-driven hop — see the postBatch handler below).
function buildListCommand( id ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = VIEW;
	m[ TO ] = `${ HTTP }/raw-logs`;
	m[ ID ] = id;
	m[ VALUE ] = { name: 'list_logs', arguments: '' };
	return m;
}

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`;
 *                                      defaults to a freshly-constructed CommandClient.
 * @return {{ selectLog: Function, setPaused: Function }} Control callbacks for
 *   the thin React view (the view's own state is read via useNodeState). Reset
 *   Graph is driven by the overlay via `Core.reinit`, stashed by mountExospine.
 */
export function useRawLogsGraph( opts = {} ) {
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Live node handles for the control callbacks (stable across renders).
	const sseRef = useRef( null );
	const viewRef = useRef( null );
	const heartbeatRef = useRef( null );

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

			// I/O boundary nodes — the same ones useConsoleGraph mounts.
			// SseInNode requires baseUrl/nonce/subscribe; we assign the
			// substrate-required fields directly instead of going through the
			// positional `arguments=` setter, since there's no log selected yet.
			const sse = interpreter.makeNode( 'SseIn', SSE );
			sse.baseUrl = data.restUrl || '/wp-json/';
			sse.nonce = data.nonce || '';
			sse.subscribe = [];
			sse.target = VIEW;

			const http = interpreter.makeNode( 'HttpOut', HTTP );
			http.client =
				optsRef.current.commandClient ||
				new CommandClient( {
					baseUrl: data.restUrl || '/wp-json/',
					nonce: data.nonce || '',
				} );

			const heartbeat = interpreter.makeNode( 'Heartbeat', HEARTBEAT );
			// `_http/workers` — the SSE_Slot_Pool's `heartbeat` verb lives on the
			// request-scope `workers` CI. The reply is discarded by Heartbeat.fill.
			heartbeat.target = `${ HTTP }/workers`;
			// HeartbeatNode hitchhikes the backbone's TIMER (setTimer() with no
			// args): the _router's notify_timer calls heartbeat.fireCb -> fire each
			// tick, which pokes the slot keep-alive. Without this the slot TTLs out
			// and the browser reconnects every ~30s. Mirrors the other SSE graphs.
			heartbeat.setTimer();

			// View-model node — envelope→row shaping is inlined into its fill().
			const view = interpreter.makeNode( 'RawLogsView', VIEW );

			// Slot bridge: a `connected`-event subscriber on `_sse` pushes the
			// live slot into `_heartbeat`. Mirrors useConsoleGraph.
			sse.register( 'connected', 'useRawLogsGraph', ( payload ) => {
				const slot =
					payload && Number.isInteger( payload.slot )
						? payload.slot
						: null;
				const partition =
					payload && Number.isInteger( payload.partition )
						? payload.partition
						: -1;
				if ( null !== slot && slot >= 0 ) {
					heartbeat.setSlot( slot, partition );
				} else {
					heartbeat.clearSlot();
				}
				return true;
			} );

			sseRef.current = sse;
			viewRef.current = view;
			heartbeatRef.current = heartbeat;

			// Re-render so useNodeState re-subscribes to the freshly-mounted view.
			bumpBuild( ( n ) => n + 1 );

			// Fire list_logs through _http. The reply (FROM=VIEW) is captured via
			// the view's pending Map, then fed back as `{action:'logs',logs}` and
			// the EventSource opens on the default-selected log.
			const listId = makeOpId();
			const listFuture = new Promise( ( resolve, reject ) => {
				view.pending.set( listId, { resolve, reject } );
			} );
			interpreter.fill( buildListCommand( listId ) );
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
						sse.close();
						sse.subscribe = [ selected ];
						sse.start();
					}
				} )
				.catch( () => {
					// list_logs failure is silent — the dropdown stays empty; the
					// reconnect banner / per-request error surface handles the rest.
				} );

			// Non-node side effects undone before the nodes are removed.
			return () => {
				heartbeat.clearSlot();
				sse.unregister( 'connected', 'useRawLogsGraph' );
				sse.close();
				sseRef.current = null;
				viewRef.current = null;
				heartbeatRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Visibility gate: close the stream while hidden (the slot TTLs out anyway),
	// reopen the currently-selected log on refocus. The initial open is driven by
	// the list_logs reply above, so this no-ops until a log is selected.
	useEffect( () => {
		const sse = sseRef.current;
		if ( ! sse ) {
			return;
		}
		if ( isPageVisible ) {
			const selected = viewRef.current?.setStateCache?.view?.selected;
			if ( selected ) {
				sse.subscribe = [ selected ];
				sse.start();
			}
		} else {
			sse.close();
			heartbeatRef.current?.clearSlot();
		}
	}, [ isPageVisible ] );

	// selectLog: the view clears+sets the selection; `_sse` re-opens for the new log.
	const selectLog = ( log ) => {
		const view = viewRef.current;
		const sse = sseRef.current;
		if ( view ) {
			view.fill( controlMsg( { action: 'select', log } ) );
		}
		if ( sse ) {
			sse.close();
			sse.subscribe = [ log ];
			sse.start();
		}
	};

	const setPaused = ( paused ) => {
		if ( viewRef.current ) {
			viewRef.current.fill( controlMsg( { action: 'pause', paused } ) );
		}
	};

	return { selectLog, setPaused };
}
