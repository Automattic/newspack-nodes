/* eslint-env jest */
/**
 * answerConfirm — press one of a `Confirm`'s buttons and let its exit play, so
 * the answer has run by the time this returns. `throughExit` does the same for
 * any press that closes a dialog: an ESC, a submit, a mousedown on the
 * backdrop.
 *
 * Fake timers cover the press alone and real ones come back after it, so a
 * suite that waits on the real clock around the question keeps it. Only the
 * timeout the exit runs on is faked (`fakeExitClock`): an interval or a frame
 * a graph armed on the real clock keeps running on it. A test that asserts
 * mid-exit calls `fakeExitClock` itself and restores real timers after.
 */

import { act, fireEvent } from '@testing-library/react';
import { MODAL_EXIT_MS } from '../hooks/useModalExit';

/**
 * Fake the timeout a dialog's exit runs on, and nothing else: intervals and
 * animation frames stay on the real clock.
 *
 * @return {void}
 */
export function fakeExitClock() {
	jest.useFakeTimers( {
		doNotFake: [ 'setInterval', 'requestAnimationFrame' ],
	} );
}

/**
 * Run `press`, then advance past the dialog's exit.
 *
 * @param {() => void} press What closes the dialog.
 * @return {void}
 */
export function throughExit( press ) {
	fakeExitClock();
	try {
		press();
		act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	} finally {
		jest.useRealTimers();
	}
}

/**
 * Click `button`, then advance past the dialog's exit.
 *
 * @param {HTMLElement} button The answer to press.
 * @return {void}
 */
export function answerConfirm( button ) {
	throughExit( () => fireEvent.click( button ) );
}
