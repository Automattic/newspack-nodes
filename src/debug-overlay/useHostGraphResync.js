/**
 * useHostGraphResync — keep the open debug overlay in lockstep with the host
 * page's live graph.
 *
 * The overlay is a floating panel rendered over a host dashboard; it binds to
 * the host's `_command_interpreter` backbone at mount and renders that graph on
 * its canvas. When the host switches DevTools tabs the old dashboard's exospine
 * is torn down and a fresh one is mounted (a new backbone + new build nodes),
 * which bumps `Core.graphGeneration` (see mountExospine). Before this hook the
 * overlay didn't react, so it kept showing the previous graph + a now-stale
 * canvas layout until the user manually clicked Reset Graph then Reset Layout.
 *
 * This hook subscribes to that shared signal while the overlay is open and, on
 * an EXTERNAL bump, runs the exact same two-step automatically: resetGraph (tear
 * down + rebuild every node off the now-current backbone) then resetLayout
 * (clear the saved positions so the canvas auto-fits the new graph).
 *
 * resetGraph itself bumps the generation. To avoid an infinite loop, every
 * overlay-initiated reset — the auto-resync AND the manual Reset Graph chip
 * (routed through the returned `resetGraph`) — runs inside a re-entrancy guard
 * that swallows the synchronous self-bump it triggers. Only a bump that arrives
 * while the guard is down (a genuine host swap) drives a resync.
 *
 * @param {Object}   params
 * @param {Function} params.resetGraph  Tear-down-and-rebuild-every-node (bumps graphGeneration).
 * @param {Function} params.resetLayout Clear saved canvas positions so the graph re-auto-fits.
 * @return {{ resync: Function, resetGraph: Function }} `resync()` runs Reset Graph then Reset Layout; `resetGraph()` is the guarded manual chip handler (single Reset Graph, no redundant auto-resync).
 */

import { useCallback, useEffect, useRef } from '@wordpress/element';
import { Core } from '../runtime/core';

export function useHostGraphResync( { resetGraph, resetLayout } ) {
	// Re-entrancy guard: an overlay-initiated resetGraph bumps the generation
	// synchronously, re-firing the subscriber mid-reset. Any bump seen while this
	// is up is self-caused — swallow it. A bump while it's down is a host swap.
	const inResyncRef = useRef( false );

	// Latest reset callbacks, read by the stable closures below so the effect
	// resubscribes only on active changes (not on every render).
	const fnsRef = useRef( { resetGraph, resetLayout } );
	fnsRef.current = { resetGraph, resetLayout };

	// Run fn with the self-bump guard raised so its synchronous graphGeneration
	// bump doesn't re-enter the subscriber.
	const guarded = useCallback( ( fn ) => {
		inResyncRef.current = true;
		try {
			fn();
		} finally {
			inResyncRef.current = false;
		}
	}, [] );

	// Auto-resync: Reset Graph then Reset Layout, as one self-caused unit.
	const resync = useCallback( () => {
		guarded( () => {
			fnsRef.current.resetGraph();
			fnsRef.current.resetLayout();
		} );
	}, [ guarded ] );

	// Manual Reset Graph chip: a single Reset Graph, guarded so its bump doesn't
	// trip a redundant auto-resync (the user reset the graph on purpose).
	const guardedResetGraph = useCallback( () => {
		guarded( () => fnsRef.current.resetGraph() );
	}, [ guarded ] );

	// The overlay panel mounts this hook only while open, so subscribing for the
	// hook's whole lifetime is "subscribe only while open" — no active flag needed.
	useEffect(
		() =>
			Core.subscribeGraphGeneration( () => {
				if ( inResyncRef.current ) {
					return;
				}
				resync();
			} ),
		[ resync ]
	);

	return { resync, resetGraph: guardedResetGraph };
}
