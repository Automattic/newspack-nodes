/**
 * useBatchedPoll — the mount and batching boilerplate every poll-pattern
 * dashboard would otherwise re-wire, so that a dashboard hook is only its
 * slices. It sets four things up, and the caller never touches them:
 *
 *  - the exospine mount, which raises the `_command_interpreter` sinking into
 *    `_router`, plus that backbone's `_http` HttpOut egress and its
 *    observe-only `_shell` Tap,
 *  - the `_http` command client, which is the I/O boundary HttpOut defaults to,
 *  - a fan-out `Tee` and a router-hitchhiking `Timer` targeting it, so one tick
 *    reaches every slice,
 *  - the page-visibility gate. A hidden tab unregisters the Timer from the
 *    Router's TIMER channel, so nothing fans out and nothing POSTs; a visible
 *    one registers it again.
 *
 * It brackets nothing itself. The Router owns the `HttpOut` lock and flush
 * around a tick, so every command that tick mints leaves in ONE POST; opening a
 * bracket here would make this mount a second bracket owner and cost the tick a
 * second POST. A first load or a `pollNow()` marks this Timer due and then runs
 * the Router's tick, which is how whatever else was due rides the same POST.
 *
 * The caller supplies a `build( { interpreter, tee } )` adding ONLY the
 * dashboard-specific nodes, typically one `addSliceFetcher` per slice. The
 * egress target path stays the caller's: the exospine provides `_shell` and
 * `_http`, and the caller names the server CI mount owning the verb, which
 * `egressPath( ci )` spells.
 *
 *   useBatchedPoll( {
 *     build:      ( { interpreter, tee } ) => slices.forEach( … ),
 *     timerName:  'insights:timer',
 *     teeName:    'insights:tee',
 *     intervalMs: 10000,
 *     paused,          // suspend the poll without unmounting (a drag in flight)
 *   } );
 *
 * It returns the live interpreter and a `pollNow()`, and re-renders after every
 * build so that each widget's `useNodeState` re-subscribes to the freshly
 * mounted view nodes.
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

/** @typedef {import('../../runtime/tee-node').TeeNode} TeeNode */
/** @typedef {import('../../runtime/node').NodeClass} NodeClass */
/** @typedef {import('../../runtime/timer-node').TimerNode} TimerNode */
/** @typedef {import('../../runtime/command-interpreter-node').CommandInterpreterNode} CommandInterpreterNode */

/**
 * What a `build` callback is handed: the backbone it registers its slices on,
 * and the Tee the tick reaches them through.
 *
 * @typedef  {Object}                 BatchedPollSpine
 * @property {CommandInterpreterNode} interpreter The graph's `_command_interpreter`.
 * @property {TeeNode}                tee         The owned fan-out Tee, already the Timer's target.
 */

/**
 * Listener id for the one-shot first load. Its presence in the Timer's FIRE
 * registrations is the whole record that the load is still owed, so there is no
 * second copy of that state to fall out of step with it.
 */
const FIRST_LOAD_LISTENER = 'useBatchedPoll:first-load';

/**
 * Listener id for the permanent unsigned-tick retry. A tick firing before the
 * command session exists mints nothing, so it is re-offered on the next tick
 * rather than waited out for a whole interval.
 */
const UNSIGNED_LISTENER = 'useBatchedPoll:unsigned';

/**
 * Default cadence for a catalog slice, in milliseconds.
 *
 * A catalog changes when someone EDITS it, so its poll is a retry rather than a
 * feed: slow enough that the palette's whole class list is not on the wire every
 * second, often enough that a turned-over session recovers without a reload. A
 * list moving on a clock of its own — rows that expire — states a faster cadence
 * through `intervalMs`.
 */
const CATALOG_MS = 30000;

/**
 * Does this mount still owe its one first load?
 *
 * The first-load listener retires itself by answering false on the tick that
 * delivers it, and `Node`'s `notify()` drops a listener that does, so asking
 * whether it is still registered is asking whether the load has happened.
 *
 * @param {TimerNode} timer The owned Timer node.
 * @return {boolean} True while the first load is still owed.
 */
function isFirstLoadPending( timer ) {
	return Object.prototype.hasOwnProperty.call(
		timer.registrations.FIRE,
		FIRST_LOAD_LISTENER
	);
}

/**
 * Arm or disarm the owned Timer against the gates deciding whether this mount
 * should be polling at all.
 *
 * A paused mount stays armed while its first load is still owed, because pause
 * suspends a CADENCE and a surface that has never shown its data has no cadence
 * to suspend. `enabled` carries no such exemption: a surface nobody opened owes
 * nothing.
 *
 * @param {TimerNode} timer         The owned Timer node.
 * @param {boolean}   isPageVisible Whether the tab is showing.
 * @param {boolean}   paused        The caller's pause flag.
 * @param {number}    intervalMs    Cadence to arm, in milliseconds.
 * @param {boolean}   [enabled]     False disarms outright.
 * @return {void}
 */
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
 * @param {Object}                           opts             Poll configuration.
 * @param {( spine: BatchedPollSpine ) => *} opts.build       Adds the dashboard's slice nodes onto the owned Tee. A function it returns runs as cleanup, before those nodes are removed.
 * @param {string}                           opts.timerName   Name for the owned router-hitchhike Timer.
 * @param {string}                           opts.teeName     Name for the owned fan-out Tee.
 * @param {boolean}                          [opts.paused]    Suspend polling while true (stops the Timer hitchhike, like a hidden tab); resumes when false. A paused mount STILL delivers its one first load — see `enabled` for the gate that does not.
 * @param {boolean}                          [opts.enabled]   False costs nothing at all: no first load, no timer. `paused` suspends a surface that is open; this is for one that was never opened. Flipping it true delivers the first load then.
 * @param {boolean}                          [opts.passenger] True to clip onto a backbone somebody else owns — a poll that is a PART of a page rather than its graph. The owner keeps Reset Graph and the full rebuild; a passenger re-attaches when the backbone comes back.
 * @param {number}                           opts.intervalMs  Poll cadence in ms, REQUIRED and >= 1000 — TimerNode's hitchhike threshold, so the tick stays inside the lock/flush bracket. 1000 rides every router tick; above that `fireCb` throttles to the interval against the shared wall-clock grid (ADR-17), so two surfaces on one cadence meet on the same tick and share the POST. Changing it re-arms the Timer.
 * @return {{interpreterRef: {current: ?CommandInterpreterNode}, pollNow: () => void}} A ref to the live interpreter, and `pollNow()` — fire the batched poll tick off-cadence.
 * @throws {TypeError} When `intervalMs` is absent or below the 1000ms floor.
 */
export function useBatchedPoll( opts ) {
	// @longform
	// Required, and >= 1000, which is TimerNode's own hitchhike threshold.
	// The batch IS the lock/flush bracket the Router puts around
	// `notifyTimer`, so only a router-hitchhiking timer sits inside it; a
	// sub-second value takes an own setInterval slot firing outside the
	// bracket, which is one POST per slice per tick and no batch at all.
	// Sub-second polling belongs to `useRouterTick`. The floor also makes
	// arming a plain `setTimer( intervalMs )` with no branch: a bare
	// `setTimer()` takes its interval from the Router and would discard the
	// caller's cadence without a word.
	if ( ! ( opts.intervalMs >= 1000 ) ) {
		throw new TypeError(
			`useBatchedPoll( { timerName: '${ opts.timerName }' } ) needs an intervalMs >= 1000`
		);
	}
	// Read opts live inside build without re-running the once-only effect.
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Bumped after (re)build so widgets' useNodeState rebinds to new views.
	const [ , bumpBuild ] = useState( 0 );

	// Interpreter and Timer, captured in build so the sync effect reaches them.
	const interpreterRef = useRef( null );
	const timerRef = useRef( null );

	// Runs ONE batched tick; captured during build like the two refs above.
	const fireTickRef = useRef( null );

	// Pause polling while the tab is hidden.
	const isPageVisible = usePageVisibility();

	// A surface nobody opened owns NOTHING — no request, and no named node.
	const enabled = false !== opts.enabled;

	useEffect( () => {
		if ( ! enabled ) {
			return undefined;
		}
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
			// The Router is the page's one heartbeat and the only thing
			// bracketing a tick; a lock/flush opened here would make this
			// mount a second bracket owner, and whatever else was due on
			// the same tick would pay for a second POST. Zeroing
			// `lastFireTime` is how a slice slower than the tick says it
			// is due, since `fireCb` throttles a hitchhiker whose interval
			// exceeds the 1s tick. `requestTick` coalesces, so three
			// mounts in one commit are one tick.
			const fireTick = () => {
				timer.markDue();
				Core.node( names.ROUTER )?.requestTick();
			};
			fireTickRef.current = fireTick;

			// An unsigned tick minted nothing, so re-offer it on the next.
			timer.register( 'FIRE', UNSIGNED_LISTENER, () => {
				if ( ! hasSession() ) {
					timer.markDue();
				}
			} );

			// @longform The first load lands on the first SIGNED tick, then
			// retires itself by answering false. A paused mount armed only
			// to get it stops again here, which is why pause is re-read
			// rather than trusted from arming time.
			timer.register( 'FIRE', FIRST_LOAD_LISTENER, () => {
				if ( ! hasSession() ) {
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
				optsRef.current.intervalMs
			);
			if ( visible ) {
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
	}, [ enabled ] );

	// Sync visibility/pause/cadence; a pending first load overrides pause.
	useEffect( () => {
		const timer = timerRef.current;
		if ( ! timer ) {
			return;
		}
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
	}, [ isPageVisible, opts.paused, opts.intervalMs, enabled ] );

	/**
	 * Run the ROUTER's tick NOW, off-cadence, having marked this poll due —
	 * one batched POST of every slice, with each `argsFn()` reading the
	 * caller's current refs.
	 *
	 * This is how a consumer refreshes after a filter change. The tick already
	 * fans to every slice inside the Router's lock/flush bracket, so nothing
	 * is left to hand-batch: rebuilding that bracket around hand-sent copies of
	 * the same verbs re-implements this one line.
	 *
	 * @return {void}
	 */
	const pollNow = useCallback( () => fireTickRef.current?.(), [] );

	return { interpreterRef, pollNow };
}

/**
 * useCatalogSlice — poll one CI's `list` verb as a slice and read what it
 * published: the whole of a catalog hook that is not its own field names.
 *
 * Every catalog wants this — the palette's classes, the OPEN dialog's saved
 * topologies, the vault_id dropdown's vaults. A one-shot load behind a latch or
 * a memoised promise empties its list for the life of the page the first time it
 * fails; polled, the tick IS the retry, and a save owes the list no reload.
 * Riding the router tick, batched with everything else due on it, the poll costs
 * no request of its own. Not `useCatalog` — that name is the console's catalog
 * CONTEXT.
 *
 * @param {Object}           o              Options.
 * @param {string}           o.scope        Names this catalog's own nodes.
 * @param {string}           o.ci           The server CI mount owning `list`.
 * @param {string|NodeClass} o.viewClass    The view class publishing the slice, or its registered name (ADR-16).
 * @param {string}           o.key          The model field holding the list — empty until the
 *                                          first reply lands, which is what `loading` reads.
 * @param {boolean}          [o.enabled]    False costs no request at all, so a surface that
 *                                          is never opened is free.
 * @param {number}           [o.intervalMs] Cadence; defaults to the catalog cadence. A
 *                                          list that moves on a clock of its own — rows
 *                                          that expire — states a faster one.
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
	intervalMs = CATALOG_MS,
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
