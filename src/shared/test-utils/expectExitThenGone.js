/* eslint-env jest */
/**
 * expectExitThenGone — the open shared dialog is playing its exit, and is gone
 * once the exit has had its time. The caller has installed fake timers.
 */

import { act } from '@testing-library/react';
import { MODAL_EXIT_MS } from '../hooks/useModalExit';

/**
 * Assert the dialog's backdrop is closing, advance past the exit, and assert
 * the dialog has unmounted.
 *
 * @return {void}
 */
export function expectExitThenGone() {
	const dialog = document.querySelector( '[role="dialog"]' );
	expect( dialog ).not.toBeNull();
	expect(
		dialog.closest( '.newspack-nodes-modal__backdrop' ).className
	).toContain( 'is-closing' );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( document.querySelector( '[role="dialog"]' ) ).toBeNull();
}
