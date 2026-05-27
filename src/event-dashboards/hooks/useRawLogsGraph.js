/**
 * useRawLogsGraph — mounts the Raw Logs dashboard node graph clipped onto the
 * exospine (the canonical rule-#2 backbone `_command_interpreter → _router`).
 *
 * Graph: `rawlogs:stream` (SSE-in) → `rawlogs:route` (classifier) →
 * `rawlogs:transform` (envelope → row) and/or `rawlogs:view` (view model).
 * EVERY node sinks into the CI; flow is steered ONLY by each node's `target`
 * (the router peels TO and delivers): the stream targets the route; the route
 * stamps data → the transform and connection-status control → the view; the
 * transform targets the view. There is no bespoke `sink`/`controlSink` wiring.
 *
 * On mount it fires the `list_logs` command and feeds the result into the view
 * (which defaults the selection to the first log), then subscribes the stream
 * to that log. The view publishes its state via `setState('view', …)`; the
 * React view reads it with `useNodeState('rawlogs:view','view')`.
 *
 * Returns the thin control callbacks the view calls — `selectLog` (clear+select
 * in the view AND re-connect the stream) and `setPaused`. Torn down on unmount:
 * the stream is closed, the graph nodes are unregistered, then the exospine.
 *
 * I/O boundaries are injectable: tests pass `opts.connector` (the stream's
 * transport seam) and `opts.commandClient` (the `list_logs` sender) so the hook
 * never touches a real EventSource or the network.
 */

import { useEffect, useRef } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { createRawLogsStream } from '../nodes/rawLogsStream';
import { createRawLogsRoute } from '../nodes/rawLogsRoute';
import { createRawLogsTransform } from '../nodes/rawLogsTransform';
import { createRawLogsView } from '../nodes/rawLogsView';
import { TYPE, VALUE, TM_STRUCT, newMessage } from '../../runtime/message';
import { getCommandClient } from '../../shared/utils/commandClient';
import unwrapCommandResponse from '../../shared/utils/unwrapCommandResponse';

// Every named node this graph mounts — unregistered on teardown (the exospine
// nodes are removed separately by its own teardown()).
const STREAM = 'rawlogs:stream';
const ROUTE = 'rawlogs:route';
const TRANSFORM = 'rawlogs:transform';
const VIEW = 'rawlogs:view';
const GRAPH_NODE_NAMES = [ STREAM, ROUTE, TRANSFORM, VIEW ];

// Build a TM_STRUCT control message the view's fill() routes on its `action`.
const controlMsg = ( value ) => {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ VALUE ] = value;
	return m;
};

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.connector]     Stream transport seam (connect/close);
 *                                      defaults to the real-EventSource connector.
 * @param {Object} [opts.commandClient] `list_logs` sender; defaults to the
 *                                      shared CommandClient singleton.
 * @return {{ selectLog: Function, setPaused: Function }} Control callbacks for
 *   the thin React view (the view's own state is read via useNodeState).
 */
export function useRawLogsGraph( opts = {} ) {
	// Stash the latest opts so the effect reads them without re-subscribing.
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Live node handles for the control callbacks (stable across renders).
	const streamRef = useRef( null );
	const viewRef = useRef( null );

	useEffect( () => {
		const { connector, commandClient } = optsRef.current;

		// The canonical backbone every node clips onto: everything → CI → router.
		const { ci, teardown: teardownSpine } = mountExospine();

		// Build the graph nodes (the factories register them in Core).
		const stream = createRawLogsStream( STREAM, { connector } );
		const route = createRawLogsRoute( ROUTE, {
			dataTarget: TRANSFORM,
			controlTarget: VIEW,
		} );
		const transform = createRawLogsTransform( TRANSFORM );
		const view = createRawLogsView( VIEW );

		// Rule #2: every node sinks into the CI; flow is steered by `target`.
		stream.sink = ci;
		stream.target = ROUTE;
		route.sink = ci;
		transform.sink = ci;
		transform.target = VIEW;
		view.sink = ci;

		streamRef.current = stream;
		viewRef.current = view;

		// Fire list_logs; on reply push the logs into the view (which defaults the
		// selection to logs[0].key) and subscribe the stream to the selected log.
		// `cancelled` guards a reply that lands after an immediate unmount.
		let cancelled = false;
		const client = commandClient || getCommandClient();
		client
			.send( { to: 'raw-logs', verb: 'list_logs' } )
			.then( ( message ) => {
				if ( cancelled ) {
					return;
				}
				const logs = unwrapCommandResponse( message ) || [];
				view.fill( controlMsg( { action: 'logs', logs } ) );
				const selected = view.setStateCache.view.selected;
				if ( selected ) {
					stream.subscribe( selected );
				}
			} )
			.catch( () => {} );

		return () => {
			cancelled = true;
			stream.close();
			for ( const name of GRAPH_NODE_NAMES ) {
				Core.unregisterNode( name );
			}
			teardownSpine();
			streamRef.current = null;
			viewRef.current = null;
		};
	}, [] );

	// selectLog: the view clears+sets the selection; the stream re-connects.
	const selectLog = ( log ) => {
		if ( viewRef.current ) {
			viewRef.current.fill( controlMsg( { action: 'select', log } ) );
		}
		if ( streamRef.current ) {
			streamRef.current.subscribe( log );
		}
	};

	const setPaused = ( paused ) => {
		if ( viewRef.current ) {
			viewRef.current.fill( controlMsg( { action: 'pause', paused } ) );
		}
	};

	return { selectLog, setPaused };
}
