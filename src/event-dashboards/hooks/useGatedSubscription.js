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
 *
 * @param {Object} o
 * @param {Object} o.linkRef A ref to the RemoteLink node (`setSubscribe`/`close`/`resumePositions`).
 * @param {Object} o.viewRef A ref to the view node (the pause control is published to it).
 * @return {{ isPausedRef: Object, resubscribe: Function, setPaused: Function }}
 *   `isPausedRef` (for a mount rebuild to re-apply a surviving pause), `resubscribe`,
 *   and `setPaused` (flips the gate + publishes the pause control for the UI).
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { newMessage, TYPE, VALUE, TM_STRUCT } from '../../runtime/message';

// Reopen: explicit seek wins; else resume the same dir (tail a changed dir).
export function reopenSeed( link, { subscribe, positions } ) {
	if ( positions ) {
		return positions;
	}
	const resume = link.resumePositions();
	return resume && 1 === subscribe.length && resume[ subscribe[ 0 ] ]
		? { [ subscribe[ 0 ] ]: resume[ subscribe[ 0 ] ] }
		: null;
}

export function useGatedSubscription( { linkRef, viewRef } ) {
	const isPageVisible = usePageVisibility();

	// Pause closes the SSE stream (frees the server slot); play resumes.
	const [ isPaused, setIsPaused ] = useState( false );
	const isPausedRef = useRef( isPaused );
	isPausedRef.current = isPaused;
	// Open only when visible AND unpaused; pause outranks a refocus.
	const isActive = isPageVisible && ! isPaused;
	const isActiveRef = useRef( isActive );
	isActiveRef.current = isActive;

	// The intended {subscribe, positions}: the reopen source of truth.
	const pendingTargetRef = useRef( null );
	// Record the target; setSubscribe only while active (Play re-applies it).
	const resubscribe = useCallback(
		( subscribe, positions ) => {
			pendingTargetRef.current = { subscribe, positions };
			if ( isActiveRef.current ) {
				linkRef.current?.setSubscribe( subscribe, positions );
			}
		},
		[ linkRef ]
	);

	// Open/resume (recorded target) while active; close when hidden OR paused.
	useEffect( () => {
		const link = linkRef.current;
		if ( ! link ) {
			return;
		}
		if ( ! isActive ) {
			link.close();
			return;
		}
		const target = pendingTargetRef.current;
		if ( target ) {
			link.setSubscribe( target.subscribe, reopenSeed( link, target ) );
		}
	}, [ isActive, linkRef ] );

	// Pause closes the stream (isActive effect); flag drives button + label.
	const setPaused = useCallback(
		( paused ) => {
			setIsPaused( paused );
			const m = newMessage();
			m[ TYPE ] = TM_STRUCT;
			m[ VALUE ] = { action: 'pause', paused };
			viewRef.current?.fill( m );
		},
		[ viewRef ]
	);

	return { isPausedRef, resubscribe, setPaused };
}
