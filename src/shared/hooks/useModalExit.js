/**
 * useModalExit — the one close timing every dialog shares: `close()` marks the
 * dialog closing so its exit animation can play, then runs `onClose` once the
 * animation has had `MODAL_EXIT_MS`. `closeWith( run )` is the same close with
 * an answer: `run` runs in place of `onClose`, so a button that acts and
 * closes plays the exit first. `close` takes no argument, so it can be handed
 * to an `onClick` as it is.
 *
 * Only the first close counts while the exit plays. Every later one, with or
 * without an answer, is ignored, so an ESC followed by a button during the
 * exit runs the ESC's close alone. Once the close has run the hook resets, so
 * a dialog its caller keeps open shows again, takes input and can close again.
 * A dialog unmounted during its exit runs the pending close at once.
 *
 * Under `prefers-reduced-motion: reduce` there is no animation to wait for, so
 * the close runs at once and `closing` never turns true.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';

export const MODAL_EXIT_MS = 240;

/**
 * Splits a dialog's close into the exit animation and the caller's own close.
 *
 * `close()` does nothing without an `onClose`, and `closeWith( run )` needs
 * none.
 *
 * @param {?() => void} onClose Runs once the exit has played; the latest one wins.
 * @return {{closing: boolean, close: () => void, closeWith: (run: () => void) => void}} `closing` is true while the exit plays, from the close until it has run.
 */
export function useModalExit( onClose ) {
	// Inline-arrow callers change identity each render; read the latest.
	const onCloseRef = useRef( onClose );
	onCloseRef.current = onClose;

	const [ closing, setClosing ] = useState( false );
	const latched = useRef( false );
	const timer = useRef( null );
	const pending = useRef( null );

	// An unmount during the exit flushes the close rather than dropping it.
	useEffect(
		() => () => {
			clearTimeout( timer.current );
			pending.current?.();
		},
		[]
	);

	const closeWith = useCallback( ( run ) => {
		if ( latched.current || ! ( run ?? onCloseRef.current ) ) {
			return;
		}
		latched.current = true;
		// A close that throws still resets, so the dialog shows again.
		const settle = () => {
			pending.current = null;
			try {
				( run ?? onCloseRef.current )?.();
			} finally {
				latched.current = false;
			}
		};
		if (
			window.matchMedia?.( '(prefers-reduced-motion: reduce)' )?.matches
		) {
			settle();
			return;
		}
		setClosing( true );
		pending.current = settle;
		timer.current = setTimeout( () => {
			try {
				settle();
			} finally {
				setClosing( false );
			}
		}, MODAL_EXIT_MS );
	}, [] );
	const close = useCallback( () => closeWith( null ), [ closeWith ] );

	return { closing, close, closeWith };
}
