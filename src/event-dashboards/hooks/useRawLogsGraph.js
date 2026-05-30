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
 * On mount the hook fires `list_logs` through `_http` to populate the dropdown,
 * then (re)opens the EventSource against the default-selected log. `selectLog`
 * closes the current source, reassigns `_sse.subscribe`, and reopens.
 *
 * The slot bridge mirrors useRequestLogGraph: a `connected`-event subscriber on
 * `_sse` reads `payload.slot` / `.partition` and pushes them into `_heartbeat`.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { SseInNode } from '../../runtime/sse-in-node';
import { HttpOutNode } from '../../runtime/http-out-node';
import { HeartbeatNode } from '../../runtime/heartbeat-node';
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
import { createRawLogsView } from '../nodes/rawLogsView';

// The I/O boundary nodes mounted from the substrate runtime.
const SSE = '_sse';
const HTTP = '_http';
const HEARTBEAT = '_heartbeat';
// The dashboard view-model node.
const VIEW = 'rawlogs:view';
// Every named node this graph mounts — unregistered on teardown (exospine
// nodes are removed separately by `teardownSpine()`).
const GRAPH_NODE_NAMES = [ SSE, HTTP, HEARTBEAT, VIEW ];

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
	m[ VALUE ] = { name: 'list_logs', arguments: '', payload: null };
	return m;
}

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`;
 *                                      defaults to a freshly-constructed CommandClient.
 * @return {{ selectLog: Function, setPaused: Function }} Control callbacks for
 *   the thin React view (the view's own state is read via useNodeState).
 */
export function useRawLogsGraph( opts = {} ) {
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Live node handles for the control callbacks (stable across renders).
	const sseRef = useRef( null );
	const viewRef = useRef( null );

	// Flipped true once the graph (and its view node) is mounted, so a consumer
	// using useNodeState re-subscribes to the now-registered view node.
	const [ , setViewReady ] = useState( false );

	useEffect( () => {
		const data =
			( typeof window !== 'undefined' && window.NewspackNodesData ) || {};

		// The canonical backbone every node clips onto: everything → interpreter → router.
		const { interpreter, teardown: teardownSpine } = mountExospine();

		// I/O boundary nodes — the same ones useRequestLogGraph mounts.
		// SseInNode (SseConnector) requires baseUrl/nonce/subscribe; we assign the
		// substrate-required fields directly instead of going through the
		// positional `arguments=` setter, since there's no log selected yet.
		// The list_logs reply (or selectLog) sets the real subscribe + start()s.
		const sse = new SseInNode();
		sse.baseUrl = data.restUrl || '/wp-json/';
		sse.nonce = data.nonce || '';
		sse.subscribe = [];
		sse.setName( SSE );
		sse.sink = interpreter;
		sse.target = VIEW;

		const http = new HttpOutNode();
		http.client =
			optsRef.current.commandClient ||
			new CommandClient( {
				baseUrl: data.restUrl || '/wp-json/',
				nonce: data.nonce || '',
			} );
		http.setName( HTTP );
		http.sink = interpreter;

		const heartbeat = new HeartbeatNode();
		heartbeat.setName( HEARTBEAT );
		heartbeat.sink = interpreter;
		// `_http/workers` — the SSE_Slot_Pool's `heartbeat` verb lives on the
		// request-scope `workers` CI. Bypass the _sse pid-pivot: the reply is
		// discarded by Heartbeat.fill anyway.
		heartbeat.target = `${ HTTP }/workers`;

		// View-model node — envelope→row shaping is inlined into its fill().
		const view = createRawLogsView( VIEW );
		view.sink = interpreter;

		// Slot bridge: a `connected`-event subscriber on `_sse` pushes the live
		// slot into `_heartbeat`. Mirrors useRequestLogGraph.
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

		// Re-render so useNodeState re-subscribes to the freshly-mounted view node.
		setViewReady( true );

		// Fire list_logs through _http. The view receives the reply (FROM=VIEW),
		// but only acts on TM_STRUCT controls — so we listen for the reply on
		// the client side and feed it into the view as `{action:'logs',logs}`.
		const listId = makeOpId();
		const listPromise = optsRef.current.commandClient
			? Promise.resolve( null ) // tests don't need the lazy default branch
			: null;
		void listPromise;
		// Stash a resolver in the view's pending Map so the list_logs reply is
		// captured into a Promise we can chain off.
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

		return () => {
			heartbeat.clearSlot();
			sse.unregister( 'connected', 'useRawLogsGraph' );
			sse.close();
			for ( const name of GRAPH_NODE_NAMES ) {
				Core.unregisterNode( name );
			}
			teardownSpine();
			sseRef.current = null;
			viewRef.current = null;
		};
	}, [] );

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
