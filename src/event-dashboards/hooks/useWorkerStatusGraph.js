/* global localStorage */
/**
 * useWorkerStatusGraph — mounts the Worker Status dashboard node graph clipped
 * onto the exospine (the canonical rule-#2 backbone `_command_interpreter →
 * _router`). On mount it builds three nodes — `workerstatus:poll` (dump_metadata
 * transport), `workerstatus:transform` (snapshot → enriched render model),
 * `workerstatus:view` (the view model React reads). EVERY node sinks into the CI;
 * flow is steered ONLY by each node's `target` (the router peels TO and delivers):
 * the poll targets the transform, the transform targets the view. There is no
 * bespoke `poll.sink=transform` wiring. It fires one immediate `poll()`. The view
 * publishes its state via `setState('view', …)`; the React view reads it
 * separately with `useNodeState('workerstatus:view','view')`.
 *
 * The hook OWNS the poll interval: a setInterval at the current refresh ms that
 * fires `poll.poll()`, running only while the page is visible (Worker Status has
 * NO SSE — the live data is the repeated poll). It pauses/resumes when the
 * interval changes or visibility flips, and clears on unmount. This mirrors how
 * Raw Logs' hook owned the list_logs fire while the node owned transport.
 *
 * Returns the thin control callbacks the view calls — `restart` (→ poll.restart),
 * `setRefreshInterval` (persists to localStorage + re-times the interval), and
 * the current `refreshMs`. Torn down on unmount: the interval is cleared, the
 * poll + view nodes are closed (cancel any in-flight poll / pending slide-out
 * timer), then the three graph nodes are unregistered, then the exospine.
 *
 * The command boundary is injectable: tests pass `opts.commandClient` (threaded
 * to the poll node) so the hook never touches the network. Production lazily
 * defaults to the shared CommandClient singleton inside the poll node.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { createWorkerStatusPoll } from '../nodes/workerStatusPoll';
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

// Every named node this graph mounts — unregistered on teardown (the exospine
// nodes are removed separately by its own teardown()).
const POLL = 'workerstatus:poll';
const TRANSFORM = 'workerstatus:transform';
const VIEW = 'workerstatus:view';
const GRAPH_NODE_NAMES = [ POLL, TRANSFORM, VIEW ];

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
 * @param {Object} [opts.commandClient] Command-client seam threaded to the poll
 *                                      node; defaults to the shared singleton.
 * @param {number} [opts.refreshMs]     Fallback interval if nothing is persisted.
 * @return {{ restart: Function, setRefreshInterval: Function, refreshMs: string }}
 *   Control callbacks for the thin React view (the model is read via useNodeState).
 */
export function useWorkerStatusGraph( opts = {} ) {
	const { commandClient, refreshMs = 2000 } = opts;

	// The persisted refresh interval (string ms); seeds from localStorage.
	const [ refreshInterval, setRefreshIntervalState ] = useState( () =>
		initialRefresh( refreshMs )
	);

	// Stash the latest command client so the mount effect reads it without
	// re-subscribing (it only runs once).
	const commandClientRef = useRef( commandClient );
	commandClientRef.current = commandClient;

	// Live poll-node handle for the interval effect + control callbacks.
	const pollRef = useRef( null );
	const isPageVisible = usePageVisibility();

	// Flipped true once the graph (and its view node) is mounted. The mount
	// effect runs AFTER the first render, by which point useNodeState has already
	// captured a null view node and bailed; setting this state forces the
	// consumer to re-render so useNodeState re-subscribes to the now-registered
	// view node and reads the published model. Without it the dashboard stays
	// stuck on the loading placeholder (Worker Status has no rAF to mask the
	// gap, unlike Raw Logs). Mirrors useConsoleGraph's setShell re-render.
	const [ , setViewReady ] = useState( false );

	// Mount the graph once: clip it onto the exospine, then fire one immediate poll.
	useEffect( () => {
		// The canonical backbone every node clips onto: everything → CI → router.
		const { ci, teardown: teardownSpine } = mountExospine();

		const poll = createWorkerStatusPoll( POLL, {
			commandClient: commandClientRef.current,
		} );
		const transform = createWorkerStatusTransform( TRANSFORM );
		const view = createWorkerStatusView( VIEW );

		// Rule #2: every node sinks into the CI; flow is steered by `target`.
		poll.sink = ci;
		poll.target = TRANSFORM;
		transform.sink = ci;
		transform.target = VIEW;
		view.sink = ci;
		pollRef.current = poll;

		// Re-render so useNodeState re-subscribes to the freshly-mounted view node.
		setViewReady( true );
		poll.poll();

		return () => {
			// Close the I/O + timer-owning nodes first (poll's in-flight cancel
			// guard, view's slide-out timer) BEFORE unregistering — mirrors
			// useRawLogsGraph calling stream.close() before unregister.
			poll.close();
			view.close();
			for ( const name of GRAPH_NODE_NAMES ) {
				Core.unregisterNode( name );
			}
			teardownSpine();
			pollRef.current = null;
			setViewReady( false );
		};
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
			if ( pollRef.current ) {
				pollRef.current.poll();
			}
		}, intervalMs );
		return () => clearInterval( id );
	}, [ refreshInterval, isPageVisible ] );

	// Request a graceful restart for a worker type (or 'supervisor').
	const restart = ( type ) => {
		if ( pollRef.current ) {
			return pollRef.current.restart( type );
		}
		return undefined;
	};

	// Change + persist the refresh interval; the interval effect re-times.
	const setRefreshInterval = ( value ) => {
		setRefreshIntervalState( value );
	};

	return { restart, setRefreshInterval, refreshMs: refreshInterval };
}
