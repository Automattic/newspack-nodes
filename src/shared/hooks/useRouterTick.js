/**
 * useRouterTick — "call me on the router heartbeat", for any React poller.
 *
 * The Router owns exactly ONE 1s slot and dispatches it to every
 * TIMER-registered node (the hitchhike ported from Tachikoma's
 * `Router::fire_cb` and `notify_timer`). A poller riding it adds no timer of
 * its own, is torn down with the graph, shows up in the debug overlay's timer
 * list, and fires inside the Router's `_http` lock, so whatever its callback
 * mints leaves in that tick's ONE batched POST. A private `setInterval` is a
 * second heartbeat the graph can neither see, pause, nor batch.
 *
 * A PASSENGER, never an owner: it attaches to a backbone another mount owns,
 * and does nothing until one exists. Ownership decides who rebuilds on
 * Reset-Graph, so a hook calling `mountExospine` — which raises the backbone
 * when none stands — hands the graph's lifecycle to whichever surface declared
 * it first. On the console, `useTopologyCatalog` is declared before
 * `useConsoleGraph`, so a catalog poller would own the console's graph.
 *
 * Mounting before the graph is therefore normal, not an error: the hook
 * subscribes to both rebuild signals and arms itself when the owner comes up.
 *
 * Cadence is TimerNode's own rule, unmodified. An `intervalMs` of 1000 or more
 * hitchhikes the Router tick, throttled against the shared wall-clock grid
 * (ADR-17); below 1000 TimerNode gives the node a `setInterval` slot of its own
 * at exactly that interval, outside the Router's batching bracket; 0, the
 * default, fires on every Router tick. A sub-second poller still belongs here —
 * it stays a graph node, visible to `list_timers` and torn down with the graph,
 * rather than a hand-rolled interval the graph cannot see. The grid lives in
 * TimerNode alone: this hook forwards the interval and never computes a
 * boundary.
 *
 *   useRouterTick( { name: 'partition:refresh', onTick: refresh,
 *                    intervalMs: 10000, enabled: Boolean( selectedLog ) } );
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '@newspack-nodes/runtime';

import usePageVisibility from './usePageVisibility';

/**
 * The reserved command-interpreter name, which is both the liveness test for
 * the graph and the factory for the Timer. `makeNode` sinks what it builds into
 * the interpreter, and a Timer sinking there with no target emits no message at
 * all, so the 'FIRE' notification is the whole tick.
 */
const INTERPRETER = '_command_interpreter';

/**
 * Ride the Router heartbeat, so the poller adds no timer of its own.
 *
 * A hidden tab stops the Timer and a visible one re-arms it, so a backgrounded
 * dashboard polls nothing.
 *
 * @param {Object}     opts              Poller configuration.
 * @param {string}     opts.name         Node name for the Timer this hook owns; unique in the graph.
 * @param {() => void} opts.onTick       Called on each fire; a throw is caught and logged.
 * @param {number}     [opts.intervalMs] Cadence in ms; 0, the default, fires on every Router tick.
 * @param {boolean}    [opts.enabled]    False stops the Timer without unmounting the hook.
 * @return {void}
 */
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
		// iterates its registrations unguarded, so a synchronous throw aborts
		// the remaining timers and escapes into setInterval, starving every
		// timer registered after this one on every later tick. Private slots
		// cannot do that to each other; the shared heartbeat must isolate.
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
			timer.markFired();
		}
	}, [ name, enabled, isPageVisible, intervalMs, attachEpoch ] );
}
