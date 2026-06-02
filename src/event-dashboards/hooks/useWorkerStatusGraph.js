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
 * The bespoke `workerstatus:poll` Node is gone — `_http` owns the network call.
 *
 * The graph build is handed to `mountExospine( build )`, which snapshots Core so
 * the soft nodes can be torn down + rebuilt on `reinit()` ("Reset Graph"). The
 * hook OWNS the poll interval: a setInterval at the current refresh ms fires a
 * TM_COMMAND for `dump_metadata` (FROM=`workerstatus:transform` so the reply
 * pivot lands at the transform, which computes the model and emits it to the
 * view). Running only while the page is visible. `restart(type)` builds a
 * TM_COMMAND with FROM=`workerstatus:view` so the reply lands at the view and
 * settles the Promise via the canonical pending-Map gating.
 *
 * The command boundary is injectable: tests pass `opts.commandClient` assigned
 * to `_http.client` so the hook never touches the network. Production lazily
 * defaults to the shared CommandClient singleton.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { HttpOutNode } from '../../runtime/http-out-node';
import { CommandClient } from '../../runtime/command_client';
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
import { createWorkerStatusTransform } from '../nodes/workerStatusTransform';
import { createWorkerStatusView } from '../nodes/workerStatusView';
import usePageVisibility from '../../shared/hooks/usePageVisibility';

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

// Monotonic per-hook-instance ID counter — message[ID] is what the view uses
// to match a reply back to a pending Promise resolver.
let nextOpId = 0;
function makeOpId() {
	nextOpId += 1;
	return `workerstatus-op-${ Date.now() }-${ nextOpId }`;
}

/**
 * Build a TM_COMMAND addressed at the `workers` interpreter: TO=`_http/workers` so the
 * router peels `_http` and HttpOut POSTs the bare command. `from` is the reply
 * pivot — `workerstatus:transform` for dump_metadata (reply computes the
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
	const { refreshMs = 2000 } = opts;
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// The persisted refresh interval (string ms); seeds from localStorage.
	const [ refreshInterval, setRefreshIntervalState ] = useState( () =>
		initialRefresh( refreshMs )
	);

	// Live interpreter handle for the interval effect + control callbacks.
	const interpreterRef = useRef( null );
	const isPageVisible = usePageVisibility();

	// Bumped on every (re)build so the consumer re-renders and its useNodeState
	// rebinds to the freshly-registered view node. A monotonic counter, not a
	// boolean latch — reinit()'s second build must still force a render.
	const [ , bumpBuild ] = useState( 0 );

	// Mount the graph once: clip it onto the exospine, then fire one immediate poll.
	useEffect( () => {
		// The soft view-nodes the backbone clips onto. mountExospine snapshots
		// Core around this so reinit() removes exactly these and rebuilds them.
		const build = ( { interpreter } ) => {
			const data =
				( typeof window !== 'undefined' && window.NewspackNodesData ) ||
				{};

			// I/O boundary — the substrate's HttpOut.
			const http = new HttpOutNode();
			http.client =
				optsRef.current.commandClient ||
				new CommandClient( {
					baseUrl: data.restUrl || '/wp-json/',
					nonce: data.nonce || '',
				} );
			http.setName( HTTP );
			http.sink = interpreter;

			// Application chain.
			const transform = createWorkerStatusTransform( TRANSFORM );
			const view = createWorkerStatusView( VIEW );
			transform.sink = interpreter;
			transform.target = VIEW;
			view.sink = interpreter;

			interpreterRef.current = interpreter;

			// Re-render so useNodeState re-subscribes to the freshly-mounted view.
			bumpBuild( ( n ) => n + 1 );

			// Fire one immediate dump_metadata (the canonical mount-time poll).
			interpreter.fill(
				buildCommand( 'dump_metadata', '', TRANSFORM, makeOpId() )
			);

			// Non-node side effects undone before the nodes are removed.
			return () => {
				view.close();
				interpreterRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Persist the refresh choice (matches the old save-to-localStorage effect).
	useEffect( () => {
		localStorage.setItem( REFRESH_KEY, refreshInterval );
	}, [ refreshInterval ] );

	// Own the poll interval: re-timed on interval change, paused when hidden,
	// cleared on unmount. No SSE — this repeated poll IS the live data.
	useEffect( () => {
		if ( ! isPageVisible ) {
			return undefined;
		}
		const intervalMs = parseInt( refreshInterval, 10 );
		const id = setInterval( () => {
			const interpreter = interpreterRef.current;
			if ( ! interpreter ) {
				return;
			}
			interpreter.fill(
				buildCommand( 'dump_metadata', '', TRANSFORM, makeOpId() )
			);
		}, intervalMs );
		return () => clearInterval( id );
	}, [ refreshInterval, isPageVisible ] );

	// Request a graceful restart for a worker type. Returns a Promise the view
	// settles via the pending-Map (resolve on success, reject on TM_ERROR).
	const restart = useCallback( ( type ) => {
		const interpreter = interpreterRef.current;
		if ( ! interpreter ) {
			return Promise.reject( new Error( 'graph not mounted' ) );
		}
		const view = Core.node( VIEW );
		if ( ! view ) {
			return Promise.reject( new Error( 'view not mounted' ) );
		}
		const id = makeOpId();
		const promise = new Promise( ( resolve, reject ) => {
			view.pending.set( id, { resolve, reject } );
		} );
		interpreter.fill(
			buildCommand( 'restart', formatCommandArgs( [ type ] ), VIEW, id )
		);
		return promise;
	}, [] );

	// Change + persist the refresh interval; the interval effect re-times.
	const setRefreshInterval = useCallback( ( value ) => {
		setRefreshIntervalState( value );
	}, [] );

	return { restart, setRefreshInterval, refreshMs: refreshInterval };
}
