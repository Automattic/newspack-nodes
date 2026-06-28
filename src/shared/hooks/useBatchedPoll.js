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

// `_http` (HttpOut egress) and `_shell` (observe-only command Tap) are permanent
// fixtures of the exospine backbone (mountExospine); the build reuses `spine.http`
// rather than mounting its own.

// Arm the owned Timer's router-TIMER hitchhike at the optional intervalMs: > 1000
// hitchhikes + throttles in fireCb(); omitted/0 fires every router tick. Either
// way the Timer rides the shared TIMER so the tick's commands batch into ONE POST.
function armTimer( timer, intervalMs ) {
	if ( intervalMs > 1000 ) {
		timer.setTimer( intervalMs );
	} else {
		timer.setTimer();
	}
}

export function useBatchedPoll( opts ) {
	// Read opts live inside build without re-running the once-only mount effect.
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Bumped after each (re)build so widgets re-render and their useNodeState
	// re-subscribes to the freshly-mounted view nodes — child effects run before
	// this parent effect, so they bind to null on first commit otherwise.
	const [ , bumpBuild ] = useState( 0 );

	// The live interpreter (awaited-verb handle) and the owned Timer, captured
	// during build so the visibility effect can stop/start its router-TIMER
	// hitchhike without re-running the mount effect.
	const interpreterRef = useRef( null );
	const timerRef = useRef( null );

	// Pause polling while the tab is hidden.
	const isPageVisible = usePageVisibility();

	useEffect( () => {
		const build = ( { interpreter, router, http } ) => {
			const data =
				( 'undefined' !== typeof window && window.NewspackNodesData ) ||
				{};

			// I/O boundary — the substrate's HttpOut, now a backbone singleton
			// (mountExospine owns `_http`); just assign the command boundary. It's
			// injectable so tests never touch the network.
			http.client =
				optsRef.current.commandClient ||
				new CommandClient( {
					baseUrl: data.restUrl || '/wp-json/',
					nonce: data.nonce || '',
				} );

			// `_shell` (observe-only Tap; `connect _shell` watches every command
			// going out) is now a permanent fixture of the exospine backbone — no
			// need to mount it here.

			// The fan-out Tee + the router-hitchhike Timer that fans each tick to it.
			const { teeName, timerName } = optsRef.current;
			const tee = interpreter.makeNode( 'Tee', teeName );

			// The caller adds its slice nodes onto the owned Tee.
			const cleanup = optsRef.current.build( { interpreter, tee } );

			const timer = interpreter.makeNode( 'Timer', timerName );
			timer.connectNode( teeName );
			// intervalMs > 1000 hitchhikes the router TIMER and throttles in fireCb()
			// (the batch still rides one tick's POST); omitted/0 fires every tick.
			armTimer( timer, optsRef.current.intervalMs );
			timerRef.current = timer;

			interpreterRef.current = interpreter;

			// Batch: lock `_http` before the tick's notify, flush after — so the
			// whole tick's commands ride ONE POST (Tachikoma batching).
			router.beforeTimerNotify = () => http.lock();
			router.afterTimerNotify = () => http.flush();

			// Immediate first paint: fire ONE batched tick on mount (the old
			// useDashboardGraph polled on mount; without this the dashboard would
			// wait a whole interval for its first data). Same lock/flush bracket as
			// the router tick so it's ONE POST. Gated on visible AND not paused —
			// a hidden/paused mount waits for the visibility/paused effect to arm.
			// Match usePageVisibility's check (not document.hidden) so the gate is
			// consistent with the effect that re-arms the Timer.
			if (
				'visible' === document.visibilityState &&
				! optsRef.current.paused
			) {
				http.lock();
				timer.fire();
				http.flush();
			}

			// Re-render so each widget's useNodeState re-subscribes to its freshly-
			// mounted view node (child effects ran before this build).
			bumpBuild( ( n ) => n + 1 );

			// Undo the non-node hooks before the nodes are removed on teardown/rebuild.
			return () => {
				router.beforeTimerNotify = null;
				router.afterTimerNotify = null;
				timerRef.current = null;
				interpreterRef.current = null;
				if ( 'function' === typeof cleanup ) {
					cleanup();
				}
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Toggle the Timer's router-TIMER hitchhike with tab visibility AND the
	// caller's `paused` flag (e.g. an Overview drag in flight), and re-arm at the
	// current `intervalMs` (so changing the refresh selector re-paces the poll).
	// Poll only when visible and not paused; either gate stops the Timer → no
	// fan-out → no POST. Runs after the mount effect (so the timer exists); a null
	// ref no-ops.
	useEffect( () => {
		const timer = timerRef.current;
		if ( ! timer ) {
			return;
		}
		if ( isPageVisible && ! opts.paused ) {
			armTimer( timer, opts.intervalMs );
		} else {
			timer.stopTimer();
		}
	}, [ isPageVisible, opts.paused, opts.intervalMs ] );

	return { interpreterRef };
}
