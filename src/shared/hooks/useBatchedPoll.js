/**
 * useBatchedPoll — the batched-poll toolkit (helper H3): every poll-pattern
 * dashboard's mount + batch boilerplate, lifted into the substrate so a dashboard
 * hook is just its slices. It sets these up, so the caller never re-wires them:
 *
 *  - the exospine mount, which brings the `_command_interpreter → _router`
 *    backbone plus its `_http` HttpOut egress and `_shell` observe-only Tap,
 *  - the `_http` command client (the I/O boundary; injectable for tests),
 *  - a fan-out `Tee` + a router-hitchhike `Timer` that fans each tick to it,
 *  - the lock/flush bracket on the router TIMER tick, so a tick's commands batch
 *    into ONE HttpOut POST (Tachikoma batching — fan-out is free),
 *  - the page-visibility gate: HIDDEN unregisters the Timer from the router TIMER
 *    (no fan-out → no POST); VISIBLE re-registers it.
 *
 * The caller supplies a `build( { interpreter, tee } )` that adds ONLY the
 * dashboard-specific nodes — typically `slices.forEach( s => addSliceFetcher(
 * interpreter, { ...s, tee, target: '_shell/_http/<ci>' } ) )` (helper H4). The
 * egress target path (`_shell/_http/<ci>`) is the caller's: the exospine
 * provides `_shell`/`_http`, the caller names the server CI mount.
 *
 *   useBatchedPoll( {
 *     build:     ( { interpreter, tee } ) => slices.forEach( … ),
 *     timerName: 'insights:timer',
 *     teeName:   'insights:tee',
 *     commandClient,   // test seam assigned to `_http.client`
 *     paused,          // suspend the poll without unmounting (e.g. a drag in flight)
 *   } );
 *
 * Returns `{ interpreterRef }` — the live interpreter consumers fire awaited
 * verbs against — and re-renders (the `bumpBuild` semantics) after each build so
 * each widget's `useNodeState` re-subscribes to the freshly-mounted view nodes.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine, hasSession } from '@newspack-nodes/runtime';
import usePageVisibility from './usePageVisibility';

// `_http` and `_shell` are permanent exospine fixtures; the build reuses them.
const FIRST_LOAD_LISTENER = 'useBatchedPoll:first-load';

function isFirstLoadPending( timer ) {
	return Object.prototype.hasOwnProperty.call(
		timer.registrations.FIRE,
		FIRST_LOAD_LISTENER
	);
}

function syncTimer( timer, isPageVisible, paused, intervalMs ) {
	if ( isPageVisible && ( ! paused || isFirstLoadPending( timer ) ) ) {
		timer.setTimer( intervalMs );
	} else {
		timer.stopTimer();
	}
}

/**
 * Mounts the batched-poll graph once and keeps it in step with page visibility,
 * pause, and cadence. See the module overview above for what it wires up.
 *
 * @param {Object}   opts
 * @param {Function} opts.build           `( { interpreter, tee } ) => cleanup|void` — adds the dashboard's slice nodes onto the owned Tee.
 * @param {string}   opts.timerName       Name for the owned router-hitchhike Timer.
 * @param {string}   opts.teeName         Name for the owned fan-out Tee.
 * @param {Object}   [opts.commandClient] Transport seam assigned to `_http.client`.
 * @param {boolean}  [opts.paused]        Suspend polling while true (stops the Timer hitchhike, like a hidden tab); resumes when false.
 * @param {number}   opts.intervalMs      Poll cadence in ms, REQUIRED and >= 1000 — TimerNode's hitchhike threshold, so the tick stays inside the lock/flush bracket. 1000 rides every router tick; above that `fireCb` throttles to the interval. Changing it re-arms the Timer.
 * @return {{ interpreterRef: Object, pollNow: Function }} A ref to the live interpreter, and `pollNow()` — fire the batched poll tick off-cadence.
 */
export function useBatchedPoll( opts ) {
	// @longform
	// Required, and >= 1000, which is TimerNode's own hitchhike threshold. The
	// batch IS the lock/flush bracket around the router's notifyTimer, so only
	// a router-hitchhiking timer sits inside it; a sub-second value takes an
	// own slot that fires outside the bracket — one POST per slice per tick,
	// no batch at all. Sub-second belongs to useRouterTick. With the floor
	// enforced here, arming is a plain setTimer( intervalMs ) with no branch:
	// the old branch called a BARE setTimer() at exactly 1000, which took its
	// interval from the router and silently discarded the caller's cadence.
	if ( ! ( opts.intervalMs >= 1000 ) ) {
		throw new TypeError(
			`useBatchedPoll( { timerName: '${ opts.timerName }' } ) needs an intervalMs >= 1000`
		);
	}
	// Read opts live inside build without re-running once-only mount effect.
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Bumped after (re)build so widgets' useNodeState rebinds to new views.
	const [ , bumpBuild ] = useState( 0 );

	// Live interpreter + owned Timer, captured during build for visibility.
	const interpreterRef = useRef( null );
	const timerRef = useRef( null );

	// Fire ONE batched tick (lock → fire → flush), captured during build.
	const fireTickRef = useRef( null );

	// Pause polling while the tab is hidden.
	const isPageVisible = usePageVisibility();

	useEffect( () => {
		const build = ( { interpreter, router, http } ) => {
			// I/O boundary — assign the command client; injectable for tests.
			if ( optsRef.current.commandClient ) {
				http.client = optsRef.current.commandClient;
			}

			// `_shell` Tap is a backbone fixture; no mounting needed here.

			// The fan-out Tee + the router-hitchhike Timer that fans each tick.
			const { teeName, timerName } = optsRef.current;
			const tee = interpreter.makeNode( 'Tee', teeName );

			// The caller adds its slice nodes onto the owned Tee.
			const cleanup = optsRef.current.build( { interpreter, tee } );

			const timer = interpreter.makeNode( 'Timer', timerName );
			timer.connectNode( teeName );
			timerRef.current = timer;

			interpreterRef.current = interpreter;

			// Batch: lock `_http` before tick notify, flush after → ONE POST.
			router.beforeTimerNotify = () => http.lock();
			router.afterTimerNotify = () => http.flush();

			// One batched tick = ONE POST, reused to deliver the first load.
			const fireTick = () => {
				http.lock();
				timer.fire();
				http.flush();
			};
			fireTickRef.current = fireTick;

			/**
			 * A first load is delivered only when its Timer fires with a live
			 * command session.
			 */
			timer.register( 'FIRE', FIRST_LOAD_LISTENER, () => {
				if ( ! hasSession() ) {
					return;
				}
				if ( optsRef.current.paused ) {
					timer.stopTimer();
				}
				return false;
			} );

			const visible = 'visible' === document.visibilityState;
			if ( visible ) {
				fireTick();
			}
			// Paused still rides the router until one signed first load fires.
			syncTimer(
				timer,
				visible,
				optsRef.current.paused,
				optsRef.current.intervalMs
			);

			// Re-render so each widget's useNodeState rebinds to the new view.
			bumpBuild( ( n ) => n + 1 );

			// Undo the non-node hooks before the nodes are removed on teardown.
			return () => {
				router.beforeTimerNotify = null;
				router.afterTimerNotify = null;
				timerRef.current = null;
				interpreterRef.current = null;
				fireTickRef.current = null;
				if ( 'function' === typeof cleanup ) {
					cleanup();
				}
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Sync visibility/pause/cadence; a pending first load overrides pause.
	useEffect( () => {
		const timer = timerRef.current;
		if ( ! timer ) {
			return;
		}
		// Deliver the one-time load immediately when a hidden tab shows.
		if (
			isPageVisible &&
			isFirstLoadPending( timer ) &&
			'inactive' === timer.mode
		) {
			fireTickRef.current?.();
		}
		syncTimer( timer, isPageVisible, opts.paused, opts.intervalMs );
	}, [ isPageVisible, opts.paused, opts.intervalMs ] );

	/**
	 * Fire the poll tick NOW, off-cadence — one batched POST of every slice,
	 * with each slice's `argsFn()` reading the caller's current refs.
	 *
	 * This is how a consumer refreshes after a filter change: the tick already
	 * fans to every slice inside the router's lock/flush bracket, so there is
	 * nothing to hand-batch. Consumers that rebuilt that bracket around
	 * hand-sent copies of the same verbs were re-implementing this.
	 */
	const pollNow = useCallback( () => fireTickRef.current?.(), [] );

	return { interpreterRef, pollNow };
}
