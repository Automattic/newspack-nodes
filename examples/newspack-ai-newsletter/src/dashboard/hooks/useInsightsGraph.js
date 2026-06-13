/**
 * useInsightsGraph — mounts the Publisher Insights dashboard graph clipped onto
 * the canonical rule-#2 backbone (`_command_interpreter → _router`) via the
 * substrate's `_http` I/O boundary, plus the application's view-model node:
 *
 *   _http          (HttpOut — POST /command boundary; .client = CommandClient)
 *   insights:view  (the view-model node React reads + pending-Promise registry)
 *
 * EVERY node sinks into the interpreter; the router routes by TO. The `insights`
 * Service_CI verb returns the FULLY-SHAPED model synchronously in the POST body,
 * so there is NO transform node and NO SSE — the page-visibility-gated poll IS
 * the live data. The hook owns a setInterval that fires a TM_COMMAND for
 * `insights` (FROM=`insights:view`, TO=`_http/insights`); `_router` peels
 * `_http`, HttpOut POSTs the bare command, and the server CI replies TO=FROM so
 * the reply lands at the view, which parses VALUE.payload and publishes.
 *
 * The command boundary is injectable: tests pass `opts.commandClient` assigned
 * to `_http.client` so the hook never touches the network. Production lazily
 * defaults to the shared CommandClient over window.NewspackNodesData.
 *
 * The buildCommand / makeOpId / mountExospine-skeleton shape mirrors
 * useWorkerStatusGraph — intentional duplication, a tracked refinement target.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import {
	mountExospine,
	CommandClient,
	newMessage,
	TYPE,
	FROM,
	TO,
	ID,
	VALUE,
	TM_COMMAND,
} from '@newspack-nodes/runtime';
import '../nodes/register';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';

const HTTP = '_http';
const VIEW = 'insights:view';

// Monotonic per-hook-instance ID — message[ID] is what the view uses to match a
// reply back to a pending Promise (awaited verbs); the poll leaves it unmatched.
let nextOpId = 0;
function makeOpId() {
	nextOpId += 1;
	return `insights-op-${ Date.now() }-${ nextOpId }`;
}

/**
 * Build the `insights` TM_COMMAND: TO=`_http/insights` so the router peels
 * `_http` and HttpOut POSTs the bare command; FROM=`insights:view` is the reply
 * pivot (the CI replies TO=FROM, landing at the view).
 *
 * @param {string} id Correlator stamped into message[ID].
 * @return {Array} A 7-field positional Message.
 */
function buildInsightsCommand( id ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = VIEW;
	m[ TO ] = `${ HTTP }/insights`;
	m[ ID ] = id;
	m[ VALUE ] = { name: 'insights', arguments: '' };
	return m;
}

/**
 * @param {Object} [opts]               Options (test seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`.
 * @param {number} [opts.refreshMs]     Poll interval in ms (default 4000).
 */
export function useInsightsGraph( opts = {} ) {
	const { refreshMs = 4000 } = opts;
	const optsRef = useRef( opts );
	optsRef.current = opts;

	const interpreterRef = useRef( null );
	const isPageVisible = usePageVisibility();

	// Bumped after build so the consumer re-renders and its useNodeState rebinds
	// to the freshly-registered `insights:view` node (mirrors useWorkerStatusGraph).
	const [ , bumpBuild ] = useState( 0 );

	// Mount the graph once: clip it onto the exospine, then fire one immediate poll.
	useEffect( () => {
		const build = ( { interpreter } ) => {
			const data =
				( typeof window !== 'undefined' && window.NewspackNodesData ) ||
				{};

			const http = interpreter.makeNode( 'HttpOut', HTTP );
			http.client =
				optsRef.current.commandClient ||
				new CommandClient( {
					baseUrl: data.restUrl || '/wp-json/',
					nonce: data.nonce || '',
				} );

			interpreter.makeNode( 'InsightsView', VIEW );
			interpreterRef.current = interpreter;

			// Re-render so useNodeState re-subscribes to the freshly-mounted view.
			bumpBuild( ( n ) => n + 1 );

			interpreter.fill( buildInsightsCommand( makeOpId() ) );

			// Non-node side effects undone before the nodes are removed.
			return () => {
				interpreterRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Own the poll: re-timed nowhere (fixed refreshMs), paused when hidden, cleared
	// on unmount. No SSE — this repeated poll IS the live data.
	useEffect( () => {
		if ( ! isPageVisible ) {
			return undefined;
		}
		const id = setInterval( () => {
			const interpreter = interpreterRef.current;
			if ( ! interpreter ) {
				return;
			}
			interpreter.fill( buildInsightsCommand( makeOpId() ) );
		}, refreshMs );
		return () => clearInterval( id );
	}, [ refreshMs, isPageVisible ] );
}
