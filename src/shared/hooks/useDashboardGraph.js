/**
 * useDashboardGraph — the shared mount + poll skeleton every poll-based
 * dashboard hook repeats. It clips the consumer's view/transform nodes onto the
 * canonical rule-#2 backbone (`_command_interpreter → _router`) via the
 * substrate's `_http` I/O boundary, fires one immediate poll for each visible
 * graph build, then runs a page-visibility-gated `setInterval` poll. The
 * consumer keeps its own awaited verbs (restart, etc.) and refresh-interval
 * state, wiring them through the returned `interpreterRef`.
 *
 * The contract per dashboard collapses to one call:
 *
 *   const { interpreterRef } = useDashboardGraph( {
 *     mountNodes: ( interpreter ) => interpreter.makeNode( 'MyView', 'my:view' ),
 *     poll:       ( interpreter ) => interpreter.fill( buildPollCommand() ),
 *     refreshMs,            // the consumer's current interval (string or number)
 *     commandClient,        // test seam assigned to `_http.client`
 *   } );
 *
 * `mountNodes` mounts ITS nodes onto the interpreter and MAY return a cleanup
 * function (to undo non-node side effects before the nodes are removed). `_http`
 * and the backbone are owned here. A visible build polls immediately; a hidden
 * build waits until the page becomes visible. Polling then runs every
 * `refreshMs` while visible (paused when hidden, cleared on unmount).
 * `commandClient` defaults lazily to the shared CommandClient over
 * `window.NewspackNodesData` so production never has to pass one.
 *
 * @param {Object}        opts
 * @param {Function}      opts.mountNodes      `( interpreter ) => cleanup|void` — mounts the consumer's view/transform nodes.
 * @param {Function}      opts.poll            `( interpreter ) => void` — fires the dashboard's poll command on each visible build/transition + interval tick.
 * @param {number|string} [opts.refreshMs]     Poll interval in ms (default 4000); the consumer passes its current selection.
 * @param {Object}        [opts.commandClient] CommandClient seam assigned to `_http.client`.
 * @return {{ interpreterRef: Object, lastPollRef: Object }} The live interpreter
 *   ref consumers fire awaited verbs against, plus a ref carrying the wall-clock
 *   ms of the last poll fire (poll-freshness for staleness detection).
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine, CommandClient } from '@newspack-nodes/runtime';
import usePageVisibility from './usePageVisibility';

// Monotonic per-module ID counter — message[ID] matches a reply to its Promise.
let nextOpId = 0;

/**
 * @param {string} prefix Op-id prefix (the hook's name, e.g. `insights-op`).
 * @return {string} A unique, prefixed, monotonic correlation id.
 */
export function makeOpId( prefix ) {
	nextOpId += 1;
	return `${ prefix }-${ Date.now() }-${ nextOpId }`;
}

export function useDashboardGraph( opts ) {
	const { refreshMs = 4000 } = opts;
	const optsRef = useRef( opts );
	optsRef.current = opts;

	const interpreterRef = useRef( null );
	const isPageVisible = usePageVisibility();

	// Wall-clock ms of the most recent poll FIRE (not reply); 0 = never polled.
	const lastPollRef = useRef( 0 );

	// Completed builds rebind consumer state and restart the poll cycle.
	const [ buildGeneration, bumpBuild ] = useState( 0 );

	// One poll fire: skip while paused or unmounted, else poll and stamp.
	const pollNow = useCallback( () => {
		if ( optsRef.current.paused ) {
			return;
		}
		const interpreter = interpreterRef.current;
		if ( interpreter ) {
			optsRef.current.poll( interpreter );
			lastPollRef.current = Date.now();
		}
	}, [] );

	// Mount once; each exospine build publishes a new local generation.
	useEffect( () => {
		const build = ( { interpreter, http } ) => {
			// I/O boundary — assign the command client; injectable for tests.
			http.client =
				optsRef.current.commandClient || CommandClient.fromGlobal();

			// The consumer mounts its own view/transform nodes.
			const cleanup = optsRef.current.mountNodes( interpreter );

			interpreterRef.current = interpreter;

			// Re-render so useNodeState and the poll cycle bind to this graph.
			bumpBuild( ( n ) => n + 1 );

			// Run the consumer's cleanup before node removal, then drop ref.
			return () => {
				interpreterRef.current = null;
				if ( 'function' === typeof cleanup ) {
					cleanup();
				}
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Visibility exclusively owns immediate and interval polls for each build.
	useEffect( () => {
		if ( ! isPageVisible || 0 === buildGeneration ) {
			return undefined;
		}

		pollNow();

		const intervalMs = parseInt( refreshMs, 10 );
		const id = setInterval( pollNow, intervalMs );
		return () => clearInterval( id );
	}, [ buildGeneration, refreshMs, isPageVisible, pollNow ] );

	return { interpreterRef, lastPollRef };
}
