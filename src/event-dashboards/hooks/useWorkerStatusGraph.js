/* global localStorage */
/**
 * useWorkerStatusGraph — mounts the Worker Status dashboard graph clipped onto
 * the canonical rule-#2 backbone (`_command_interpreter → _router`) using the
 * substrate's `_http` I/O boundary node, plus the application's transform +
 * view-model nodes:
 *
 *   _http                   (HttpOut — POST /command boundary; .client = CommandClient)
 *   workerstatus:transform  (snapshot → enriched render model)
 *   workerstatus:view       (the view-model node React reads + pending-Promise registry)
 *
 * EVERY node sinks into the interpreter; flow is steered ONLY by each node's `target`.
 * The shared `useDashboardGraph` owns the exospine mount, the `_http` boundary,
 * the immediate + interval poll, and the page-visibility gate; this hook supplies
 * its transform + view nodes and the `dump_graph` poll command, and keeps the
 * persisted refresh interval + the awaited `restart` verb.
 *
 * The poll fires a TM_COMMAND for `dump_graph` (FROM=`workerstatus:transform`
 * so the reply pivot lands at the transform, which computes the model and emits
 * it to the view). `restart(type)` builds a TM_COMMAND with FROM=`workerstatus:view`
 * so the reply lands at the view and settles the Promise via the canonical
 * pending-Map gating, dispatched through the shared hook's `interpreterRef`.
 *
 * The command boundary is injectable: tests pass `opts.commandClient` assigned
 * to `_http.client` so the hook never touches the network. Production lazily
 * defaults to the shared CommandClient singleton.
 */

import { useCallback, useEffect, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	ID,
	VALUE,
	TM_COMMAND,
} from '../../runtime/message';
import { formatCommandArgs } from '../../runtime/command-args';
import {
	useDashboardGraph,
	makeOpId,
} from '@newspack-nodes/shared/hooks/useDashboardGraph';
import '../nodes/register';

// Refresh-interval options offered to the user (the select in the full-page view).
export const REFRESH_OPTIONS = [
	{ label: '1s', value: '1000' },
	{ label: '2s', value: '2000' },
	{ label: '5s', value: '5000' },
	{ label: '10s', value: '10000' },
];

const REFRESH_KEY = 'newspack-nodes-worker-refresh';
const LEGACY_REFRESH_KEY = 'newspack-event-logger-nodes-worker-refresh';

const HTTP = '_http';
const TRANSFORM = 'workerstatus:transform';
const VIEW = 'workerstatus:view';

/**
 * Build a TM_COMMAND addressed at the `workers` interpreter: TO=`_http/workers` so the
 * router peels `_http` and HttpOut POSTs the bare command. `from` is the reply
 * pivot — `workerstatus:transform` for dump_graph (reply computes the
 * model), `workerstatus:view` for restart (reply settles a pending Promise).
 *
 * @param {string} verb Verb name.
 * @param {string} args Argument tail the verb parses (empty for nullary verbs).
 * @param {string} from Reply-pivot FROM (which node the reply lands at).
 * @param {string} id   Correlator stamped into message[ID].
 * @return {Array} A 7-field positional Message.
 */
function buildCommand( verb, args, from, id ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = from;
	m[ TO ] = `${ HTTP }/workers`;
	m[ ID ] = id;
	m[ VALUE ] = { name: verb, arguments: args };
	return m;
}

/**
 * Resolve the initial refresh interval, migrating the legacy localStorage key.
 *
 * @param {number|string} defaultMs Fallback interval when nothing valid is stored.
 * @return {string} A valid REFRESH_OPTIONS value, or String( defaultMs ).
 */
export function initialRefresh( defaultMs ) {
	const validValues = REFRESH_OPTIONS.map( ( opt ) => opt.value );
	let saved = localStorage.getItem( REFRESH_KEY );
	if ( ! saved ) {
		const legacy = localStorage.getItem( LEGACY_REFRESH_KEY );
		if ( legacy ) {
			saved = legacy;
			try {
				localStorage.setItem( REFRESH_KEY, legacy );
			} catch ( e ) {
				// localStorage disabled/quota'd; in-session only.
			}
		}
	}
	return saved && validValues.includes( saved ) ? saved : String( defaultMs );
}

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`;
 *                                      defaults to a freshly-constructed CommandClient.
 * @param {number} [opts.refreshMs]     Fallback interval if nothing is persisted.
 * @return {{ restart: Function, setRefreshInterval: Function, refreshMs: string }}
 *   Control callbacks for the thin React view (the model is read via useNodeState).
 *   Reset Graph is driven by the overlay via `Core.reinit`, stashed by mountExospine.
 */
export function useWorkerStatusGraph( opts = {} ) {
	const { commandClient, refreshMs = 2000 } = opts;

	// The persisted refresh interval (string ms); seeds from localStorage.
	const [ refreshInterval, setRefreshIntervalState ] = useState( () =>
		initialRefresh( refreshMs )
	);

	const { interpreterRef } = useDashboardGraph( {
		mountNodes: ( interpreter ) => {
			const transform = interpreter.makeNode(
				'WorkerStatusTransform',
				TRANSFORM
			);
			const view = interpreter.makeNode( 'WorkerStatusView', VIEW );
			transform.target = VIEW;
			return () => view.close();
		},
		poll: ( interpreter ) =>
			interpreter.fill(
				buildCommand(
					'dump_graph',
					'',
					TRANSFORM,
					makeOpId( 'workerstatus-op' )
				)
			),
		refreshMs: refreshInterval,
		commandClient,
	} );

	// Persist the refresh choice (matches the old save-to-localStorage effect).
	useEffect( () => {
		localStorage.setItem( REFRESH_KEY, refreshInterval );
	}, [ refreshInterval ] );

	// Request a graceful restart for a worker type. Returns a Promise the view
	// settles via the pending-Map (resolve on success, reject on TM_ERROR).
	const restart = useCallback(
		( type ) => {
			const interpreter = interpreterRef.current;
			if ( ! interpreter ) {
				return Promise.reject( new Error( 'graph not mounted' ) );
			}
			const view = Core.node( VIEW );
			if ( ! view ) {
				return Promise.reject( new Error( 'view not mounted' ) );
			}
			const id = makeOpId( 'workerstatus-op' );
			const promise = new Promise( ( resolve, reject ) => {
				view.replies.add( id, resolve, reject );
			} );
			interpreter.fill(
				buildCommand(
					'restart',
					formatCommandArgs( [ type ] ),
					VIEW,
					id
				)
			);
			return promise;
		},
		[ interpreterRef ]
	);

	// Change + persist the refresh interval; the poll effect re-times.
	const setRefreshInterval = useCallback( ( value ) => {
		setRefreshIntervalState( value );
	}, [] );

	return { restart, setRefreshInterval, refreshMs: refreshInterval };
}
