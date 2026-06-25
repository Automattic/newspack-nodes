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
 * @return {{ interpreterRef: Object }} A ref to the live interpreter.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine, CommandClient } from '@newspack-nodes/runtime';
import usePageVisibility from './usePageVisibility';

// Substrate I/O-boundary node names: `_http` the HttpOut egress, `_shell` the
// observe-only Tap in front of it.
const HTTP = '_http';
const SHELL = '_shell';

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
		const build = ( { interpreter, router } ) => {
			const data =
				( 'undefined' !== typeof window && window.NewspackNodesData ) ||
				{};

			// I/O boundary — the substrate's HttpOut. The command boundary is
			// injectable so tests never touch the network.
			const http = interpreter.makeNode( 'HttpOut', HTTP );
			http.client =
				optsRef.current.commandClient ||
				new CommandClient( {
					baseUrl: data.restUrl || '/wp-json/',
					nonce: data.nonce || '',
				} );

			// `_shell` — observe-only Tap in front of `_http`, so `connect _shell`
			// watches every command going out. No targets: it forwards its sink.
			interpreter.makeNode( 'Tap', SHELL );

			// The fan-out Tee + the router-hitchhike Timer that fans each tick to it.
			const { teeName, timerName } = optsRef.current;
			const tee = interpreter.makeNode( 'Tee', teeName );

			// The caller adds its slice nodes onto the owned Tee.
			const cleanup = optsRef.current.build( { interpreter, tee } );

			const timer = interpreter.makeNode( 'Timer', timerName );
			timer.connectNode( teeName );
			timer.setTimer();
			timerRef.current = timer;

			interpreterRef.current = interpreter;

			// Batch: lock `_http` before the tick's notify, flush after — so the
			// whole tick's commands ride ONE POST (Tachikoma batching).
			router.beforeTimerNotify = () => http.lock();
			router.afterTimerNotify = () => http.flush();

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

	// Toggle the Timer's router-TIMER hitchhike with tab visibility. Runs after
	// the mount effect (so the timer exists); a null ref no-ops.
	useEffect( () => {
		const timer = timerRef.current;
		if ( ! timer ) {
			return;
		}
		if ( isPageVisible ) {
			timer.setTimer();
		} else {
			timer.stopTimer();
		}
	}, [ isPageVisible ] );

	return { interpreterRef };
}
