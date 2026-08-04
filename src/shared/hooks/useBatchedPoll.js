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

import { useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine, hasSession } from '@newspack-nodes/runtime';
import usePageVisibility from './usePageVisibility';

// `_http` and `_shell` are permanent exospine fixtures; the build reuses them.
const FIRST_LOAD_LISTENER = 'useBatchedPoll:first-load';

// @longform
// One second is a FLOOR here, not TimerNode's arming rule. The batch is the
// lock/flush bracket around the ROUTER's notifyTimer below, so ONLY a
// router-hitchhiking timer is inside it. Below 1000 TimerNode hands out an own
// slot, which fires outside the bracket — that is not a faster batch, it is no
// batch at all, one POST per slice per tick. Sub-second belongs to display
// ticks (useRouterTick), never here.
function armTimer( timer, intervalMs ) {
	if ( intervalMs > 1000 ) {
		timer.setTimer( intervalMs );
	} else {
		timer.setTimer();
	}
}

function isFirstLoadPending( timer ) {
	return Object.prototype.hasOwnProperty.call(
		timer.registrations.FIRE,
		FIRST_LOAD_LISTENER
	);
}

function syncTimer( timer, isPageVisible, paused, intervalMs ) {
	if ( isPageVisible && ( ! paused || isFirstLoadPending( timer ) ) ) {
		armTimer( timer, intervalMs );
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
 * @param {number}   opts.intervalMs      Poll cadence in ms, REQUIRED and > 0. Either way the Timer hitchhikes the router TIMER, so every tick stays inside the lock/flush bracket: above 1000 it throttles to that cadence, at or below 1000 it rides the router's own. Changing it re-arms the Timer.
 * @return {{ interpreterRef: Object }} A ref to the live interpreter.
 */
export function useBatchedPoll( opts ) {
	// The cadence is required: a silent fallback here polls every router tick.
	if ( ! ( opts.intervalMs > 0 ) ) {
		throw new TypeError(
			`useBatchedPoll( { timerName: '${ opts.timerName }' } ) needs an intervalMs > 0`
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

	return { interpreterRef };
}
