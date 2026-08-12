/**
 * useReconcile — hold a load as DESIRED STATE and converge on it, rather than
 * firing it once at mount and hoping.
 *
 * The bug this exists for: a dashboard that loads once is only ever as fresh as
 * the moment it mounted. A console tab left overnight fetched its graph an hour
 * before the command session expired, so no request of its own was in flight to
 * discover the refusal — the graph simply stayed empty until someone cycled tab
 * visibility by hand. Its neighbour on the same page recovered untouched,
 * because it polls.
 *
 * So the fix is not a retry at the failing call site. It is to stop modelling
 * "loaded" as an event and start modelling it as a state that must hold: while
 * unsettled, keep attempting; on success, stop. Then a refused session, a
 * renewed nonce, an expired key, a rebuilt graph and a restarted worker stop
 * being five error paths and become one word — invalidated — and every consumer
 * recovers because it must, not because someone remembered to add a retry.
 *
 * Mutations must NOT use this. Replaying a save or a delete is a worse bug than
 * the stale read it would fix.
 *
 *   const { settled, error } = useReconcile( {
 *     load:    async () => setRows( await fetchRows() ),
 *     enabled: isOpen,
 *     deps:    [ topology, partition ],
 *   } );
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { Core, authGeneration } from '@newspack-nodes/runtime';
import usePageVisibility from './usePageVisibility';

/**
 * How often an unsettled loader reconsiders.
 *
 * Deliberately its OWN slot, not the `useRouterTick` hitchhike every dashboard
 * poller uses. This loop's whole job is to converge while other things are
 * broken, and riding the Router would park it exactly when the graph is torn
 * down — during a Reset-Graph, or on a page whose graph never mounted. One
 * timer per loader is the price of that independence.
 */
const TICK_MS = 1000;

/** First retry delay, and the ceiling it doubles toward. */
export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * @param {Object}   o
 * @param {Function} o.load      Async; resolves when the state is established, throws otherwise.
 * @param {boolean}  [o.enabled] Gate — false parks the loop without clearing what settled.
 * @param {Array}    [o.deps]    Re-reconcile when any of these change.
 * @return {{settled: boolean, error: Error|null, reconcileNow: () => void}} Loop state.
 */
export default function useReconcile( { load, enabled = true, deps = [] } ) {
	const [ settled, setSettled ] = useState( false );
	const [ error, setError ] = useState( null );

	const loadRef = useRef( load );
	loadRef.current = load;

	// Attempt bookkeeping in refs: the tick reads it without re-subscribing.
	const inFlight = useRef( false );
	const nextAttemptAt = useRef( 0 );
	const backoffMs = useRef( BACKOFF_START_MS );
	const seenGeneration = useRef( authGeneration() );
	// @longform
	// Which invalidation an attempt was started under. Without it, an
	// invalidation landing mid-flight is erased by the stale attempt's
	// success: the loop settles on state established under inputs — or a
	// session, or a graph — that are already gone, and never reconsiders.
	const epoch = useRef( 0 );

	const isPageVisible = usePageVisibility();
	const depsKey = JSON.stringify( deps );

	/** Reopen the convergence window: attempt on the next tick, no backoff. */
	const openWindow = useCallback( () => {
		backoffMs.current = BACKOFF_START_MS;
		nextAttemptAt.current = 0;
	}, [] );

	const attempt = useCallback( async () => {
		if ( inFlight.current ) {
			return;
		}
		inFlight.current = true;
		const startedAt = epoch.current;
		try {
			await loadRef.current();
			if ( startedAt !== epoch.current ) {
				return;
			}
			openWindow();
			setError( null );
			setSettled( true );
		} catch ( e ) {
			if ( startedAt !== epoch.current ) {
				return;
			}
			// Stay unsettled: the next tick past the window tries again.
			nextAttemptAt.current = Date.now() + backoffMs.current;
			backoffMs.current = Math.min(
				backoffMs.current * 2,
				BACKOFF_MAX_MS
			);
			setError( e instanceof Error ? e : new Error( String( e ) ) );
			setSettled( false );
		} finally {
			inFlight.current = false;
		}
	}, [ openWindow ] );

	/** Drop what we believe and converge again — the one entry point. */
	const reconcileNow = useCallback( () => {
		epoch.current += 1;
		openWindow();
		setSettled( false );
	}, [ openWindow ] );

	// A change of inputs invalidates what settled under the old ones.
	useEffect( () => {
		reconcileNow();
	}, [ depsKey, reconcileNow ] );

	// A rebuilt graph invalidates a load that pushed into a replaced node.
	useEffect(
		() => Core.subscribeGraphGeneration( reconcileNow ),
		[ reconcileNow ]
	);

	// A fresh chance: don't wait out a backoff earned while the tab slept.
	useEffect( () => {
		if ( isPageVisible ) {
			openWindow();
		}
	}, [ isPageVisible, openWindow ] );

	useEffect( () => {
		if ( ! enabled || ! isPageVisible ) {
			return undefined;
		}

		const tick = () => {
			const generation = authGeneration();
			if ( generation !== seenGeneration.current ) {
				seenGeneration.current = generation;
				reconcileNow();
				void attempt();
				return;
			}
			if ( settled || Date.now() < nextAttemptAt.current ) {
				return;
			}
			void attempt();
		};

		tick();
		const id = setInterval( tick, TICK_MS );
		return () => clearInterval( id );
	}, [ enabled, isPageVisible, settled, attempt, reconcileNow ] );

	return { settled, error, reconcileNow };
}
