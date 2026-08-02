/**
 * useRouterTick — "call me on the router heartbeat", for any React poller.
 *
 * The Router owns exactly ONE 1s slot and dispatches it to every TIMER-registered
 * node (Tachikoma `Router::fire_cb` → `notify_timer`). A poller that rides it adds
 * no timer of its own, pauses when the graph pauses, and shows up in the debug
 * overlay's timer list. A private `setInterval` is a second heartbeat the graph
 * cannot see, pause, or batch — which is what every dashboard used to own.
 *
 * A PASSENGER, never an owner. The first version called `mountExospine`, which
 * brings up the backbone when none exists — so on the console, where
 * `useTopologyCatalog` is declared before `useConsoleGraph`, this hook's effect
 * ran first and became the backbone OWNER. Ownership decides who rebuilds on
 * Reset-Graph, so a catalog poller silently took over the console's lifecycle.
 * It now attaches to a backbone someone else owns, and does nothing until one
 * exists.
 *
 * Mounting before the graph is therefore normal, not an error: the hook
 * subscribes to the graph generation and arms itself when the owner comes up
 * (`mountExospine` bumps that generation as it mounts).
 *
 * Cadence is TimerNode's own rule, unmodified: `intervalMs >= 1000` hitchhikes the
 * Router tick and throttles to it; below 1000 TimerNode gives the node its own
 * slot at exactly that interval; 0 (the default) fires every Router tick. So a
 * sub-second poller still belongs here — it stays a graph node, visible to
 * `list_timers` and torn down with the graph, instead of a hand-rolled interval
 * the graph cannot see.
 *
 *   useRouterTick( { name: 'partition-viewer:segments', onTick: refresh,
 *                    intervalMs: 10000, enabled: Boolean( selectedLog ) } );
 *
 * @param {Object}   opts
 * @param {string}   opts.name         Unique node name for the owned Timer.
 * @param {Function} opts.onTick       Called on each (throttled) router tick.
 * @param {number}   [opts.intervalMs] Throttle in ms; >1000 throttles, else every tick.
 * @param {boolean}  [opts.enabled]    False stops the hitchhike without unmounting.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '@newspack-nodes/runtime';

import usePageVisibility from './usePageVisibility';

const INTERPRETER = '_command_interpreter';

export default function useRouterTick( {
	name,
	onTick,
	intervalMs = 0,
	enabled = true,
} ) {
	// Latest callback without re-registering the node on every render identity.
	const onTickRef = useRef( onTick );
	onTickRef.current = onTick;

	const timerRef = useRef( null );
	const isPageVisible = usePageVisibility();

	// @longform
	// Re-run the attach effect when a backbone appears or the graph is rebuilt.
	// BOTH signals are needed: a bare mount brings the backbone up without
	// bumping the generation, and a rebuild bumps the generation without
	// creating one.
	const [ attachEpoch, setAttachEpoch ] = useState( 0 );
	useEffect( () => {
		const bump = () => setAttachEpoch( ( n ) => n + 1 );
		const offGeneration = Core.subscribeGraphGeneration( bump );
		const offBackbone = Core.subscribeBackboneUp( bump );
		return () => {
			offGeneration();
			offBackbone();
		};
	}, [] );

	useEffect( () => {
		const interpreter = Core.node( INTERPRETER );
		// No graph yet (or torn down mid-rebuild); the generation bump retries.
		if ( ! interpreter ) {
			return undefined;
		}

		const timer = interpreter.makeNode( 'Timer', name );
		// @longform
		// Two contracts in one callback. It returns NOTHING: notify() deletes
		// any listener returning false, which is how useBatchedPoll's
		// first-load listener is one-shot. And it swallows: notifyTimer
		// iterates its registrations unguarded, so a synchronous throw aborted
		// the remaining timers and escaped into setInterval, starving every
		// timer registered after this one on every later tick. Private slots
		// could not do that to each other; the shared heartbeat must isolate.
		timer.register( 'FIRE', `${ name }:tick`, () => {
			try {
				onTickRef.current();
			} catch ( e ) {
				Core.printLessOften(
					`ERROR: useRouterTick(${ name }): ${ e?.message || e }`
				);
			}
		} );
		timerRef.current = timer;

		return () => {
			timerRef.current = null;
			timer.removeNode();
		};
	}, [ name, attachEpoch ] );

	useEffect( () => {
		const timer = timerRef.current;
		if ( ! timer ) {
			return;
		}
		if ( ! enabled || ! isPageVisible ) {
			timer.stopTimer();
			return;
		}
		// @longform
		// Forward the interval and let TimerNode choose the mode: >=1000
		// hitchhikes the Router tick, below 1000 takes its own slot at that
		// exact interval. Passing no argument discards the caller's cadence.
		if ( intervalMs > 0 ) {
			timer.setTimer( intervalMs );
		} else {
			timer.setTimer();
		}
		// @longform
		// setTimer zeroes lastFireTime, so the next Router tick passes the
		// throttle whatever the interval. Start the window now — every adopter
		// already loads once on mount, and re-arming on tab focus repeats it.
		// Only the throttled hitchhike reads this.
		if ( intervalMs > 1000 ) {
			timer.lastFireTime = Core.now();
		}
	}, [ name, enabled, isPageVisible, intervalMs, attachEpoch ] );
}
