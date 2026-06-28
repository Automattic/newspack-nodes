/**
 * useDashboardGraph — the shared mount + poll skeleton every poll-based
 * dashboard hook repeats. It clips the consumer's view/transform nodes onto the
 * canonical rule-#2 backbone (`_command_interpreter → _router`) via the
 * substrate's `_http` I/O boundary, fires one immediate poll on mount, then
 * runs a page-visibility-gated `setInterval` poll. The consumer keeps its own
 * awaited verbs (restart, etc.) and refresh-interval state, wiring them through
 * the returned `interpreterRef`.
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
 * and the backbone are owned here. The poll fires immediately on mount and then
 * every `refreshMs` while the page is visible (paused when hidden, cleared on
 * unmount). `commandClient` defaults lazily to the shared CommandClient over
 * `window.NewspackNodesData` so production never has to pass one.
 *
 * @param {Object}        opts
 * @param {Function}      opts.mountNodes      `( interpreter ) => cleanup|void` — mounts the consumer's view/transform nodes.
 * @param {Function}      opts.poll            `( interpreter ) => void` — fires the dashboard's poll command. Called immediately + on each interval tick.
 * @param {number|string} [opts.refreshMs]     Poll interval in ms (default 4000); the consumer passes its current selection.
 * @param {Object}        [opts.commandClient] CommandClient seam assigned to `_http.client`.
 * @return {{ interpreterRef: Object, lastPollRef: Object }} The live interpreter
 *   ref consumers fire awaited verbs against, plus a ref carrying the wall-clock
 *   ms of the last poll fire (poll-freshness for staleness detection).
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine, CommandClient } from '@newspack-nodes/runtime';
import usePageVisibility from './usePageVisibility';

// Monotonic per-module ID counter — message[ID] is what a view uses to match a
// reply back to a pending Promise (awaited verbs). Duplicated in every dashboard
// hook before this; shared here.
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

	// Wall-clock ms of the most recent poll FIRE (not reply) — it stops advancing
	// whenever polling pauses (hidden tab, paused drag), so consumers can derive
	// fire-freshness from it. Reply-success freshness is the consumer's job (it
	// owns the view nodes the replies land on). Additive, ref-typed so reading it
	// never forces a re-render. Starts 0 (never polled).
	const lastPollRef = useRef( 0 );

	// The visibility effect fires an immediate poll whenever it runs while visible,
	// EXCEPT on the very first effect run (the mount effect's poll already covered
	// that initial commit). A later become-visible run is a genuine hide→show and
	// must refresh at once.
	const visibilityEffectRan = useRef( false );

	// Bumped after build so the consumer re-renders and its useNodeState rebinds
	// to the freshly-mounted view node(s).
	const [ , bumpBuild ] = useState( 0 );

	// One poll fire: skip while paused (an in-progress drag) or before the graph
	// is mounted, else poll and stamp the freshness clock. Read live from optsRef
	// so toggling pause never re-times the interval.
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

	// Mount the graph once: clip it onto the exospine, then fire one immediate poll.
	useEffect( () => {
		const build = ( { interpreter, http } ) => {
			const data =
				( typeof window !== 'undefined' && window.NewspackNodesData ) ||
				{};

			// I/O boundary — the backbone's shared `_http` singleton (mountExospine
			// owns it); just assign the command boundary. Injectable so tests never
			// touch the network.
			http.client =
				optsRef.current.commandClient ||
				new CommandClient( {
					baseUrl: data.restUrl || '/wp-json/',
					nonce: data.nonce || '',
				} );

			// The consumer mounts its own view/transform nodes.
			const cleanup = optsRef.current.mountNodes( interpreter );

			interpreterRef.current = interpreter;

			// Re-render so useNodeState re-subscribes to the freshly-mounted view.
			bumpBuild( ( n ) => n + 1 );

			// Fire one immediate poll (the canonical mount-time poll) and stamp
			// the freshness clock.
			optsRef.current.poll( interpreter );
			lastPollRef.current = Date.now();

			// Run the consumer's cleanup before the nodes are removed, then drop
			// the live ref.
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

	// Own the poll interval: re-timed on interval change, paused when hidden,
	// cleared on unmount. Reads the live interpreter ref each tick.
	useEffect( () => {
		// The first effect run is the initial-mount commit, whose poll the mount
		// effect already fired — don't double-poll. Every run after that which is
		// visible is a genuine become-visible transition: poll immediately so
		// hide→show shows fresh data without waiting a full interval.
		const isFirstRun = ! visibilityEffectRan.current;
		visibilityEffectRan.current = true;

		if ( ! isPageVisible ) {
			return undefined;
		}

		if ( ! isFirstRun ) {
			pollNow();
		}

		const intervalMs = parseInt( refreshMs, 10 );
		const id = setInterval( pollNow, intervalMs );
		return () => clearInterval( id );
	}, [ refreshMs, isPageVisible, pollNow ] );

	return { interpreterRef, lastPollRef };
}
