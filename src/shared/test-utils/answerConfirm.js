/* eslint-env jest */
/**
 * answerConfirm — press one of a `Confirm`'s buttons and let its exit play, so
 * the answer has run by the time this returns. `throughExit` does the same for
 * any press that closes a dialog: an ESC, a submit, a mousedown on the
 * backdrop.
 *
 * Fake timers cover the press alone and real ones come back after it, so a
 * suite that waits on the real clock around the question keeps it. Only the
 * timeout the exit runs on is faked: an interval or a frame a graph armed on
 * the real clock keeps running on it.
 */

import { act, fireEvent } from '@testing-library/react';
import { MODAL_EXIT_MS } from '../hooks/useModalExit';

/**
 * Run `press`, then advance past the dialog's exit.
 *
 * @param {() => void} press What closes the dialog.
 * @return {void}
 */
export function throughExit( press ) {
	jest.useFakeTimers( {
		doNotFake: [ 'setInterval', 'requestAnimationFrame' ],
	} );
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
