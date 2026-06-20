/* global localStorage */
/**
 * useAggregatorStatusGraph — mounts the Aggregator Status dashboard node graph
 * onto the canonical rule-#2 backbone (`_command_interpreter → _router`) using
 * the substrate's HTTP I/O boundary node — the minimal mount surface a
 * poll-only dashboard needs:
 *
 *   _http       (HttpOutNode — POST /command boundary; .client = CommandClient)
 *
 * Plus the application's render-model node:
 *
 *   aggregator:view (the view-model node the React view reads)
 *
 * Dashboards aren't REPLs: no transcript window, no tab-completion input, no
 * uptime display, no `cd` navigation. So `_output` / `_completion` / `_uptime` /
 * `_cwd` are NOT mounted here — they'd be dead weight and would collide with
 * the debug-overlay's REPL when it opens on this page.
 *
 * The graph build is handed to `mountExospine( build )`, which snapshots Core so
 * the soft nodes can be torn down + rebuilt on `reinit()` ("Reset Graph"). The
 * hook owns the poll setInterval — on every tick it builds a TM_COMMAND
 * (FROM=`aggregator:view`, TO=`_http/aggregator`, verb=`status`) and fills it
 * into the interpreter. The router peels `_http`, HttpOutNode POSTs the command, the server
 * pivots the reply TO=FROM, the router peels `aggregator:view`, and the view
 * unwraps the payload into its render model. No bespoke `aggregator:poll` node.
 *
 * NOT gated on page visibility — the old AggregatorStatus polled
 * unconditionally, so the migration preserves that exactly. The 1s "ago" tick
 * that refreshes relative timestamps stays in the thin view — pure display.
 *
 * The command boundary is injectable: tests pass `opts.commandClient` (assigned
 * to `_http.client`) so the hook never touches the network. Production lazily
 * defaults to the shared CommandClient singleton.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import {
	mountExospine,
	CommandClient,
	newMessage,
	TYPE,
	TO,
	FROM,
	VALUE,
	TM_COMMAND,
} from '@newspack-nodes/runtime';
import '../nodes/register';

// The I/O boundary node mounted from the substrate runtime.
const HTTP = '_http';
// The application's render-model node.
const VIEW = 'aggregator:view';

// Refresh-interval options offered to the user (the select in the dashboard).
export const REFRESH_OPTIONS = [
	{ label: '1s', value: '1000' },
	{ label: '2s', value: '2000' },
	{ label: '5s', value: '5000' },
	{ label: '10s', value: '10000' },
];

export const DEFAULT_REFRESH_MS = '2000';
const REFRESH_KEY = 'aggregator-status-refresh';

/**
 * Resolve the initial refresh interval from localStorage (matches the old
 * AggregatorStatus useState initializer).
 *
 * @return {string} A valid REFRESH_OPTIONS value, or DEFAULT_REFRESH_MS.
 */
function initialRefresh() {
	const validValues = REFRESH_OPTIONS.map( ( opt ) => opt.value );
	const saved = localStorage.getItem( REFRESH_KEY );
	if ( saved && validValues.includes( saved ) ) {
		return saved;
	}
	return DEFAULT_REFRESH_MS;
}

/**
 * Build the poll TM_COMMAND: FROM=`aggregator:view` so the server's reply pivot
 * lands on the view; TO=`_http/aggregator` so the router peels `_http` and
 * HttpOutNode POSTs the bare `aggregator.status` command (no worker indirection).
 *
 * @return {Array} A 7-field positional Message.
 */
function buildPollMessage() {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = VIEW;
	m[ TO ] = `${ HTTP }/aggregator`;
	m[ VALUE ] = { name: 'status', arguments: '' };
	return m;
}

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`;
 *                                      defaults to a freshly-constructed CommandClient.
 * @return {{ setRefreshInterval: Function, refreshInterval: string }} Control
 *   callbacks for the thin React view (the model is read via useNodeState). Reset
 *   Graph is driven by the overlay via `Core.reinit`, stashed by mountExospine.
 */
export function useAggregatorStatusGraph( opts = {} ) {
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// The persisted refresh interval (string ms); seeds from localStorage.
	const [ refreshInterval, setRefreshIntervalState ] =
		useState( initialRefresh );

	// Live interpreter handle for the poll-interval effect.
	const interpreterRef = useRef( null );

	// Bumped on every (re)build so a consumer's useNodeState re-subscribes to the
	// freshly-registered view node. A monotonic counter, not a boolean latch —
	// reinit()'s second build must still force a render.
	const [ , bumpBuild ] = useState( 0 );

	// Mount the graph once: clip it onto the exospine, then fire one immediate poll.
	useEffect( () => {
		// The soft view-nodes the backbone clips onto. mountExospine snapshots
		// Core around this so reinit() removes exactly these and rebuilds them.
		const build = ( { interpreter } ) => {
			const data =
				( typeof window !== 'undefined' && window.NewspackNodesData ) ||
				{};

			// I/O boundary node — HttpOutNode is the only one this poll-only dashboard
			// needs.
			const http = interpreter.makeNode( 'HttpOut', HTTP );
			http.client =
				optsRef.current.commandClient ||
				new CommandClient( {
					baseUrl: data.restUrl || '/wp-json/',
					nonce: data.nonce || '',
				} );

			// The application view-model node — the receiver of the poll reply via the
			// server's TO=FROM pivot.
			interpreter.makeNode( 'AggregatorView', VIEW );

			interpreterRef.current = interpreter;

			// Re-render so useNodeState re-subscribes to the freshly-mounted view node.
			bumpBuild( ( n ) => n + 1 );

			// Fire one immediate poll: the canonical "everything sinks into the interpreter"
			// path — interpreter forwards (non-command, non-empty-TO) to router → router peels
			// `_http` → HttpOutNode.fill POSTs the command.
			interpreter.fill( buildPollMessage() );

			// Non-node side effects undone before the nodes are removed.
			return () => {
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

	// Own the poll interval: re-timed on interval change, cleared on unmount. NOT
	// gated on visibility — the old AggregatorStatus polled unconditionally. Reads
	// the live interpreter ref each tick, so it keeps polling the stable backbone
	// across a reinit (the fresh view receives the reply via TO=FROM by name).
	useEffect( () => {
		const intervalMs = parseInt( refreshInterval, 10 );
		const id = setInterval( () => {
			if ( interpreterRef.current ) {
				interpreterRef.current.fill( buildPollMessage() );
			}
		}, intervalMs );
		return () => clearInterval( id );
	}, [ refreshInterval ] );

	// Change + persist the refresh interval; the interval effect re-times.
	const setRefreshInterval = ( value ) => {
		setRefreshIntervalState( value );
	};

	return { setRefreshInterval, refreshInterval };
}
