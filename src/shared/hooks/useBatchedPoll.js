/**
 * useBatchedPoll — the batched-poll toolkit (helper H3): every poll-pattern
 * dashboard's mount + batch boilerplate, lifted into the substrate so a dashboard
 * hook is just its slices. It owns, so the caller never re-wires them:
 *
 *  - the exospine mount (`_command_interpreter → _router` backbone),
 *  - the `_http` HttpOut egress (command boundary; client injectable for tests),
 *  - the `_shell` observe-only Tap in front of `_http` (`connect _shell` watches
 *    every command going out),
 *  - a fan-out `Tee` + a router-hitchhike `Timer` that fans each tick to it,
 *  - the lock/flush bracket on the router TIMER tick, so a tick's commands batch
 *    into ONE HttpOut POST (Tachikoma batching — fan-out is free),
 *  - the page-visibility gate: HIDDEN unregisters the Timer from the router TIMER
 *    (no fan-out → no POST); VISIBLE re-registers it.
 *
 * The caller supplies a `build( { interpreter, tee } )` that adds ONLY the
 * dashboard-specific nodes — typically `slices.forEach( s => addSliceFetcher(
 * interpreter, { ...s, tee, target: '_shell/_http/<ci>' } ) )` (helper H4). The
 * egress target path (`_shell/_http/<ci>`) is the caller's: `useBatchedPoll`
 * owns `_shell`/`_http`, the caller names the server CI mount.
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
 *
 * @param {Object}   opts
 * @param {Function} opts.build           `( { interpreter, tee } ) => cleanup|void` — adds the dashboard's slice nodes onto the owned Tee.
 * @param {string}   opts.timerName       Name for the owned router-hitchhike Timer.
 * @param {string}   opts.teeName         Name for the owned fan-out Tee.
 * @param {Object}   [opts.commandClient] CommandClient seam assigned to `_http.client`.
 * @param {boolean}  [opts.paused]        Suspend polling while true (stops the Timer hitchhike, like a hidden tab); resumes when false.
 * @param {number}   [opts.intervalMs]    Poll cadence in ms: > 1000 hitchhikes + throttles to it; omitted/0 fires every router tick. Changing it re-arms the Timer.
 * @return {{ interpreterRef: Object }} A ref to the live interpreter.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine, CommandClient } from '@newspack-nodes/runtime';
import usePageVisibility from './usePageVisibility';

// `_http` and `_shell` are permanent exospine fixtures; the build reuses them.

// Arm the Timer's router-TIMER hitchhike: >1000 throttles, else every tick.
function armTimer( timer, intervalMs ) {
	if ( intervalMs > 1000 ) {
		timer.setTimer( intervalMs );
	} else {
		timer.setTimer();
	}
}

export function useBatchedPoll( opts ) {
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
	const firstLoadDoneRef = useRef( false );

	// Pause polling while the tab is hidden.
	const isPageVisible = usePageVisibility();

	useEffect( () => {
		const build = ( { interpreter, router, http } ) => {
			// I/O boundary — assign the command client; injectable for tests.
			http.client =
				optsRef.current.commandClient || CommandClient.fromGlobal();

			// `_shell` Tap is a backbone fixture; no mounting needed here.

			// The fan-out Tee + the router-hitchhike Timer that fans each tick.
			const { teeName, timerName } = optsRef.current;
			const tee = interpreter.makeNode( 'Tee', teeName );

			// The caller adds its slice nodes onto the owned Tee.
			const cleanup = optsRef.current.build( { interpreter, tee } );

			const timer = interpreter.makeNode( 'Timer', timerName );
			timer.connectNode( teeName );
			// intervalMs > 1000 throttles in fireCb(); else fires every tick.
			armTimer( timer, optsRef.current.intervalMs );
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

			// First paint: fire ONE tick on mount, gated on visibility only.
			if ( 'visible' === document.visibilityState ) {
				fireTick();
				firstLoadDoneRef.current = true;
			}

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

	// Poll only when visible and not paused; re-arm at the current intervalMs.
	useEffect( () => {
		const timer = timerRef.current;
		if ( ! timer ) {
			return;
		}
		// Deliver the one-time load when the tab shows, even while paused.
		if ( isPageVisible && ! firstLoadDoneRef.current ) {
			fireTickRef.current?.();
			firstLoadDoneRef.current = true;
		}
		if ( isPageVisible && ! opts.paused ) {
			armTimer( timer, opts.intervalMs );
		} else {
			timer.stopTimer();
		}
	}, [ isPageVisible, opts.paused, opts.intervalMs ] );

	return { interpreterRef };
}
