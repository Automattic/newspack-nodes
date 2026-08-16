/**
 * useGatedSubscription — the pause/visibility stream-gating shared by the
 * Partition Viewer and Log Viewer hooks (their gating blocks were byte-identical
 * once pause learned to disconnect).
 *
 * A stream is open only while the tab is visible AND the user hasn't paused
 * (`isActive`). Pause uses the SAME close path as the visibility gate — it is
 * just "inactive" — so pausing frees the bounded server SSE slot, and pause
 * outranks a visibility refocus (a paused stream stays closed through hide →
 * refocus). Every control that re-points the stream (select a log/source, seek a
 * segment) goes through `resubscribe`: it records the intended
 * `{ subscribe, positions }` and only calls `setSubscribe` while active — so
 * changing the selection WHILE PAUSED can never revive the closed EventSource.
 * Play/refocus re-applies the recorded target via `reopenSeed`, resuming the
 * same-dir tail from the last offset but honoring an explicit paused-time seek.
 * An explicit seek is SINGLE-USE: the instant it's delivered (immediately if
 * active, else on the next Play/refocus), the recorded target reverts to
 * `positions: null` — so a LATER pause/play or visibility cycle resumes from
 * wherever the live tail actually is (`resumePositions()`) instead of
 * re-applying the same seek forever. This matters because a Replay's
 * catch-up-to-live flip is a display-only signal (SeekTracker) that never
 * re-calls `resubscribe` — without single-use consumption, pausing any time
 * after a Replay would keep jumping back to the original replay start.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { stepPosition } from '@newspack-nodes/shared/hooks/useLogPositions';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { controlMsg } from '../../shared/helpers/controlMsg';

// Reopen: explicit seek wins; else resume the same dir (tail a changed dir).
function reopenSeed( link, { subscribe, positions } ) {
	if ( positions ) {
		return positions;
	}
	const resume = link.resumePositions();
	return resume && 1 === subscribe.length && resume[ subscribe[ 0 ] ]
		? { [ subscribe[ 0 ] ]: resume[ subscribe[ 0 ] ] }
		: null;
}

/**
 * Gate an SSE subscription on tab visibility and an explicit pause, and own
 * the reopen target so a selection made while paused can never revive the
 * closed stream. See the module docblock for the full gating contract.
 *
 * @param {Object} o
 * @param {Object} o.linkRef  Ref to the RemoteLink node, whose
 *                            `setSubscribe`/`close`/`resumePositions`
 *                            open, close, and resume the stream.
 * @param {Object} o.viewRef  Ref to the view node the pause control
 *                            and stepped records are published to.
 * @param {Object} o.stepRead The one-record read behind the paused
 *                            single-step: `{ ci, command, scope,
 *                            argsFor( sub, position ), subOf( args ) }`.
 *                            This hook owns both halves — it sends the read
 *                            and applies the record — so `subOf` must be
 *                            `argsFor` read backwards; a verb with a
 *                            sub-verb does not carry the source at args[0].
 * @return {{ isPausedRef: Object, resubscribe: Function, setPaused: Function, step: () => void }}
 *   `isPausedRef` (for a mount rebuild to re-apply a surviving pause), `resubscribe`,
 *   `setPaused` (flips the gate + publishes the pause control for the UI), and
 *   `step` (paused-only: deliver one frame from the cursor, then close).
 */
export function useGatedSubscription( { linkRef, viewRef, stepRead } ) {
	const isPageVisible = usePageVisibility();

	// Pause closes the SSE stream (frees the server slot); play resumes.
	const [ isPaused, setIsPaused ] = useState( false );
	const isPausedRef = useRef( isPaused );
	isPausedRef.current = isPaused;
	const isPageVisibleRef = useRef( isPageVisible );
	isPageVisibleRef.current = isPageVisible;
	// Open only when visible AND unpaused; pause outranks a refocus.
	const isActive = isPageVisible && ! isPaused;
	const isActiveRef = useRef( isActive );
	isActiveRef.current = isActive;

	// The intended {subscribe, positions}: the reopen source of truth.
	const pendingTargetRef = useRef( null );
	// True once a delivery lands in the current activation; cleared on close.
	const deliveredRef = useRef( false );
	// @longform setSubscribe, then immediately mark the target consumed: an
	// explicit seek is single-use, so the NEXT reopen resumes live instead of
	// re-applying it (see the module docblock).
	const deliver = useCallback(
		( subscribe, positions ) => {
			pendingTargetRef.current = { subscribe, positions: null };
			deliveredRef.current = true;
			linkRef.current?.setSubscribe( subscribe, positions );
		},
		[ linkRef ]
	);

	// Record the target; deliver only while active (Play re-applies it).
	const resubscribe = useCallback(
		( subscribe, positions ) => {
			if ( isActiveRef.current ) {
				deliver( subscribe, positions );
				return;
			}
			pendingTargetRef.current = { subscribe, positions };
		},
		[ deliver ]
	);

	// Open/resume (recorded target) while active; close when hidden OR paused.
	useEffect( () => {
		const link = linkRef.current;
		if ( ! link ) {
			return;
		}
		if ( ! isActive ) {
			link.close();
			deliveredRef.current = false;
			return;
		}
		const target = pendingTargetRef.current;
		// A same-tick play+seek already delivered; don't overwrite its seek.
		if ( target && ! deliveredRef.current ) {
			deliver( target.subscribe, reopenSeed( link, target ) );
		}
	}, [ isActive, linkRef, deliver ] );

	// Pause closes the stream (isActive effect); flag drives button + label.
	const setPaused = useCallback(
		( paused ) => {
			// Refs flip NOW: a same-tick seek must record, not hit the stream.
			isPausedRef.current = paused;
			isActiveRef.current = isPageVisibleRef.current && ! paused;
			setIsPaused( paused );
			const view = viewRef.current;
			if ( view ) {
				view.fill( controlMsg( view, { action: 'pause', paused } ) );
			}
		},
		[ viewRef ]
	);

	// @longform Paused-only single-step: the stream stays OFFLINE; one record
	// is asked for over the command channel, answered a tick later as
	// `{ message, cursor }`, admitted through the view's paused belt, and the
	// recorded reopen target advances to the post-step cursor — so the NEXT
	// step continues from there and Play resumes streaming from the stepped
	// point.
	const { run: runStep } = useCommandOnce( {
		ci: stepRead.ci,
		command: stepRead.command,
		scope: stepRead.scope,
		// The reply names the dir it read; the pending target may have moved.
		onDone: ( { result, args } ) => {
			const view = viewRef.current;
			if ( ! result?.message || ! view || ! isPausedRef.current ) {
				return;
			}
			const sub = stepRead.subOf( args );
			view.fill( controlMsg( view, { action: 'step', frames: 1 } ) );
			view.fill( result.message );
			pendingTargetRef.current = {
				subscribe: [ sub ],
				positions: { [ sub ]: { ...result.cursor } },
			};
		},
	} );

	const argsFor = stepRead.argsFor;
	const step = useCallback( () => {
		const link = linkRef.current;
		const target = pendingTargetRef.current;
		if ( ! isPausedRef.current || ! link || ! target ) {
			return;
		}
		const sub = target.subscribe[ 0 ];
		const position = stepPosition( link, sub, target.positions );
		if ( null === position ) {
			return;
		}
		runStep( argsFor( sub, position ) );
	}, [ linkRef, runStep, argsFor ] );

	return { isPausedRef, resubscribe, setPaused, step };
}
