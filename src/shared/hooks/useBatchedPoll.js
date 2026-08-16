/**
 * useBatchedPoll — the batched-poll toolkit (helper H3): every poll-pattern
 * dashboard's mount + batch boilerplate, lifted into the substrate so a dashboard
 * hook is just its slices. It sets these up, so the caller never re-wires them:
 *
 *  - the exospine mount, which brings the `_command_interpreter → _router`
 *    backbone plus its `_http` HttpOut egress and `_shell` observe-only Tap,
 *  - the `_http` command client (the I/O boundary; HttpOut defaults it),
 *  - a fan-out `Tee` + a router-hitchhike `Timer` that fans each tick to it,
 *  - the page-visibility gate: HIDDEN unregisters the Timer from the router TIMER
 *    (no fan-out → no POST); VISIBLE re-registers it.
 *
 * It does NOT bracket anything. The Router owns the lock/flush around a tick, so
 * a tick's commands batch into ONE HttpOut POST (Tachikoma batching — fan-out is
 * free); a first load or a `pollNow()` says it is due and then runs the Router's
 * tick, which is how whatever else was due rides the same POST.
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
 *     paused,          // suspend the poll without unmounting (e.g. a drag in flight)
 *   } );
 *
 * Returns `{ interpreterRef }` — the live interpreter — and re-renders (the
 * `bumpBuild` semantics) after each build so each widget's `useNodeState`
 * re-subscribes to the freshly-mounted view nodes.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import {
	Core,
	mountExospine,
	hasSession,
	useNodeState,
} from '@newspack-nodes/runtime';
import { addSliceFetcher } from '../helpers/addSliceFetcher';
import { egressPath } from '../helpers/egressPath';
import names from '../../runtime/reserved-node-names.json';
import usePageVisibility from './usePageVisibility';

// `_http` and `_shell` are permanent exospine fixtures; the build reuses them.
const FIRST_LOAD_LISTENER = 'useBatchedPoll:first-load';

/** Every router tick — the floor `useBatchedPoll` enforces. */
const TICK_MS = 1000;

function isFirstLoadPending( timer ) {
	return Object.prototype.hasOwnProperty.call(
		timer.registrations.FIRE,
		FIRST_LOAD_LISTENER
	);
}

function syncTimer( timer, isPageVisible, paused, intervalMs, enabled = true ) {
	if (
		enabled &&
		isPageVisible &&
		( ! paused || isFirstLoadPending( timer ) )
	) {
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
 * @param {Function} opts.build       `( { interpreter, tee } ) => cleanup|void` — adds the dashboard's slice nodes onto the owned Tee.
 * @param {string}   opts.timerName   Name for the owned router-hitchhike Timer.
 * @param {string}   opts.teeName     Name for the owned fan-out Tee.
 * @param {boolean}  [opts.paused]    Suspend polling while true (stops the Timer hitchhike, like a hidden tab); resumes when false. A paused mount STILL delivers its one first load — see `enabled` for the gate that does not.
 * @param {boolean}  [opts.enabled]   False costs nothing at all: no first load, no timer. `paused` suspends a surface that is open; this is for one that was never opened. Flipping it true delivers the first load then.
 * @param {boolean}  [opts.passenger] True to clip onto a backbone somebody else owns — a poll that is a PART of a page rather than its graph. The owner keeps Reset Graph and the full rebuild; a passenger re-attaches when the backbone comes back.
 * @param {number}   opts.intervalMs  Poll cadence in ms, REQUIRED and >= 1000 — TimerNode's hitchhike threshold, so the tick stays inside the lock/flush bracket. 1000 rides every router tick; above that `fireCb` throttles to the interval. Changing it re-arms the Timer.
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
		const build = ( { interpreter } ) => {
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

			// @longform
			// Ask to be included in THIS tick, then let the ROUTER run it.
			// The Router is the page's one heartbeat and the only thing that
			// brackets a tick; opening a lock/flush here made this mount a
			// second bracket owner, and whatever else was due on the same tick
			// paid for a second POST. Zeroing `lastFireTime` is how a slice
			// slower than the tick says it is due, since `fireCb` throttles a
			// hitchhiker whose interval exceeds the 1s tick. `requestTick`
			// coalesces, so three mounts in one commit are one tick.
			const fireTick = () => {
				timer.lastFireTime = 0;
				Core.node( names.ROUTER )?.requestTick();
			};
			fireTickRef.current = fireTick;

			/**
			 * A first load is delivered only when its Timer fires with a live
			 * command session.
			 */
			timer.register( 'FIRE', FIRST_LOAD_LISTENER, () => {
				if ( ! hasSession() ) {
					// Nothing signed, so nothing went: not a spent tick.
					timer.lastFireTime = 0;
					return;
				}
				if ( optsRef.current.paused ) {
					timer.stopTimer();
				}
				return false;
			} );

			// ARM first: the Router fires only what its TIMER holds.
			const visible = 'visible' === document.visibilityState;
			// Paused still rides the router until one signed first load fires.
			syncTimer(
				timer,
				visible,
				optsRef.current.paused,
				optsRef.current.intervalMs,
				false !== optsRef.current.enabled
			);
			if ( visible && false !== optsRef.current.enabled ) {
				fireTick();
			}

			// Re-render so each widget's useNodeState rebinds to the new view.
			bumpBuild( ( n ) => n + 1 );

			// Undo the non-node hooks before the nodes are removed on teardown.
			return () => {
				timerRef.current = null;
				interpreterRef.current = null;
				fireTickRef.current = null;
				if ( 'function' === typeof cleanup ) {
					cleanup();
				}
			};
		};

		const { teardown } = mountExospine( build, {
			passenger: true === optsRef.current.passenger,
		} );
		return teardown;
	}, [] );

	// Sync visibility/pause/cadence; a pending first load overrides pause.
	useEffect( () => {
		const timer = timerRef.current;
		if ( ! timer ) {
			return;
		}
		const enabled = false !== opts.enabled;
		const owed =
			enabled &&
			isPageVisible &&
			isFirstLoadPending( timer ) &&
			'inactive' === timer.mode;
		// ARM first: the Router fires only what is registered on its TIMER.
		syncTimer(
			timer,
			isPageVisible,
			opts.paused,
			opts.intervalMs,
			enabled
		);
		// The one-time load, when a hidden or unopened surface finally shows.
		if ( owed ) {
			fireTickRef.current?.();
		}
	}, [ isPageVisible, opts.paused, opts.intervalMs, opts.enabled ] );

	/**
	 * Run the ROUTER's tick NOW, off-cadence, having said this poll is due —
	 * one batched POST of every slice, with each `argsFn()` reading the
	 * caller's current refs.
	 *
	 * This is how a consumer refreshes after a filter change: the tick already
	 * fans to every slice inside the Router's lock/flush bracket, so there is
	 * nothing to hand-batch. Consumers that rebuilt that bracket around
	 * hand-sent copies of the same verbs were re-implementing this.
	 */
	const pollNow = useCallback( () => fireTickRef.current?.(), [] );

	return { interpreterRef, pollNow };
}

/**
 * useCatalogSlice — poll one CI's `list` verb as a slice and read what it
 * published: the whole of a catalog hook that is not its own field names.
 *
 * Every catalog wants this — the palette's classes, the OPEN dialog's saved
 * topologies, the vault_id dropdown's vaults. Each was its own one-shot load
 * behind a latch or a memoised promise, so one failure emptied its list for the
 * life of the page. Polled, the tick IS the retry, and a save owes the list no
 * reload. It rides every router tick, and batched it costs no request of its
 * own. Not `useCatalog` — that name is the console's catalog CONTEXT.
 *
 * @param {Object}  o              Options.
 * @param {string}  o.scope        Names this catalog's own nodes.
 * @param {string}  o.ci           The server CI mount owning `list`.
 * @param {string}  o.viewClass    The registered view class publishing the slice.
 * @param {string}  o.key          The model field holding the list — empty until the
 *                                 first reply lands, which is what `loading` reads.
 * @param {boolean} [o.enabled]    False costs no request at all, so a surface that
 *                                 is never opened is free.
 * @param {number}  [o.intervalMs] Cadence; defaults to every router tick. A
 *                                 catalog that only changes when someone edits it
 *                                 can ride a slower one and still be its own retry.
 * @return {Object} The published model, plus `loading`, `error`, and a
 *                  `refresh()` for the caller that just CHANGED the list and
 *                  should not wait out the cadence to see it.
 */
export function useCatalogSlice( {
	scope,
	ci,
	viewClass,
	key,
	enabled = true,
	intervalMs = TICK_MS,
} ) {
	const { pollNow } = useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: `${ scope }:fetch`,
				receiver: `${ scope }:in`,
				command: 'list',
				view: `${ scope }:view`,
				viewClass,
				tee,
				target: egressPath( ci ),
			} ),
		timerName: `${ scope }:timer`,
		teeName: `${ scope }:tee`,
		enabled,
		intervalMs,
	} );

	const model = useNodeState( `${ scope }:view`, 'view' ) ?? {};

	return {
		...model,
		loading: enabled && ! model[ key ] && ! model.error,
		error: model.error ?? null,
		refresh: pollNow,
	};
}
