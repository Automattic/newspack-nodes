/**
 * usePublisherInsightsGraph — the Publisher Insights dashboard as a GENUINE node
 * graph, built directly on `mountExospine()` (NOT the god-pattern shortcut
 * `useDashboardGraph`, which mounts one view node + one poll command).
 *
 *   insights:timer (Timer) ─> insights:tee (Tee) ─> fetch-counts (Fetcher) ─┐
 *                                                 ├> fetch-top    (Fetcher) ─┤  target = _shell/_http/insights-demo
 *                                                 └> fetch-acc    (Fetcher) ─┘
 *   countsIn (Tee) ─> source-counts:view ─> <SourceCounts/>
 *   topIn    (Tee) ─> top-table:view     ─> <TopTable/>
 *   accIn    (Tee) ─> accumulated:view   ─> <AccumulatedCard/>
 *
 * `insights:timer` hitchhikes the _router TIMER. The router brackets each tick
 * with `_http` lock/flush (Tachikoma batching), so the timer fires `insights:tee`,
 * the Tee fans the tick to the three Fetchers, each Fetcher emits ITS configured
 * command (FROM = its receiver) routed through `_shell/_http/insights-demo` — and
 * all three commands buffer behind the lock and ship as ONE HttpOut POST. Fan-out
 * is free: more fetchers, same one request.
 *
 * `_shell` is an observe-only Tap in front of `_http`: routing the fetchers
 * through it lets `connect _shell` watch every command going out. Each Fetcher's
 * reply pivots back TO = its receiver Tee, which fans it to that slice's view
 * node — so a `counts` reply only ever touches `source-counts:view`.
 *
 * The command boundary is injectable: tests pass `opts.commandClient` assigned to
 * `_http.client` so the hook never touches the network. Production lazily defaults
 * to the shared CommandClient over window.NewspackNodesData.
 *
 * Polling is page-visibility gated (shared `usePageVisibility`): while the tab is
 * HIDDEN the timer unregisters from the router TIMER (`stopTimer()`), so a router
 * tick fans out to nothing and no HttpOut POST goes out; becoming VISIBLE again
 * re-registers it (`setTimer()`) and polling resumes. The visible cadence — the 1s
 * router-tick hitchhike and the one-POST-per-tick lock/flush batching — is unchanged.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { mountExospine, CommandClient } from '@newspack-nodes/runtime';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import '../nodes/register';

// Substrate I/O-boundary node names (literals, matching the canonical dashboard
// hooks): `_http` the HttpOut egress, `_shell` the observe-only Tap in front of it.
const HTTP = '_http';
const SHELL = '_shell';
// The server-side CI mount this example owns (the real product owns unsuffixed `insights`).
const SERVER = 'insights-demo';

// Per-slice fetcher config: [fetcher node name, receiver Tee, verb, view node, view class].
const SLICES = [
	[
		'fetch-counts',
		'countsIn',
		'counts',
		'source-counts:view',
		'SourceCountsView',
	],
	[ 'fetch-top', 'topIn', 'top', 'top-table:view', 'TopTableView' ],
	[
		'fetch-acc',
		'accIn',
		'accumulated',
		'accumulated:view',
		'AccumulatedView',
	],
];

/**
 * @param {Object} [opts]               Options (test seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`.
 */
export function usePublisherInsightsGraph( opts = {} ) {
	// Read opts live inside build without re-running the once-only mount effect.
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Bumped after each (re)build so the consuming widgets re-render and their
	// useNodeState re-subscribes to the freshly-mounted view nodes — child effects
	// run before this parent effect, so they bind to null on first commit otherwise.
	const [ , bumpBuild ] = useState( 0 );

	// The mounted Timer node, captured during build so the visibility effect can
	// stop/start its router-TIMER hitchhike without re-running the mount effect.
	const timerRef = useRef( null );

	// Pause polling while the tab is hidden: HIDDEN unregisters the timer from the
	// router TIMER (no fan-out → no POST); VISIBLE re-registers it. Idempotent — a
	// repeated setTimer()/stopTimer() on the same router-mode timer is a no-op set.
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

			// `_shell` — an observe-only Tap in front of `_http`, so `connect _shell`
			// watches every command going out. No targets: it just forwards its sink.
			interpreter.makeNode( 'Tap', SHELL );

			// The fan-out path: Timer ─> Tee ─> N Fetchers, plus a receiver Tee +
			// view node per slice.
			const tee = interpreter.makeNode( 'Tee', 'insights:tee' );
			const fetchPath = `${ SHELL }/${ HTTP }/${ SERVER }`;
			for ( const [
				fetcher,
				receiver,
				verb,
				view,
				viewClass,
			] of SLICES ) {
				const f = interpreter.makeNode(
					'Fetcher',
					fetcher,
					`${ receiver } ${ verb }`
				);
				f.connectNode( fetchPath );
				tee.connectNode( fetcher );

				const recv = interpreter.makeNode( 'Tee', receiver );
				recv.connectNode( view );
				interpreter.makeNode( viewClass, view );
			}

			// Timer hitchhikes the _router TIMER and fans each tick to the Tee.
			const timer = interpreter.makeNode( 'Timer', 'insights:timer' );
			timer.connectNode( 'insights:tee' );
			timer.setTimer();
			timerRef.current = timer;

			// Batch: lock `_http` before the tick's notify, flush after — so the
			// whole tick's fetcher commands ride ONE POST (console batching pattern).
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
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Toggle the timer's router-TIMER hitchhike with tab visibility. Runs after the
	// mount effect (so the timer exists); a null ref (pre-mount/post-teardown) no-ops.
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
}
