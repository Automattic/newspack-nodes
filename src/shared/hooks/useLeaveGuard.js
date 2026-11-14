/**
 * useLeaveGuard — while `dirty`, leaving the whole page asks first: a
 * wp-admin menu link, a reload or closing the tab raises the browser's own
 * "Leave site?" prompt, whose text no page may set. A switch inside the page,
 * such as a station tab, is the host's to ask about (`beforeLeave`).
 *
 * Canonical in newspack-nodes; consumed via the `@newspack-nodes/shared` alias.
 */

import { useEffect } from '@wordpress/element';

/**
 * Ask before the page goes while it holds a change. Each caller adds its own
 * listener, so one part of the page letting go leaves another's asking.
 *
 * @param {boolean} dirty Whether the page holds a change not yet saved.
 */
export function useLeaveGuard( dirty ) {
	useEffect( () => {
		if ( ! dirty ) {
			return undefined;
		}
		/** @param {BeforeUnloadEvent} event The navigation away. */
		const hold = ( event ) => {
			event.preventDefault();
			// Older Chromium and Safari ask only when returnValue is set.
			event.returnValue = true;
		};
		window.addEventListener( 'beforeunload', hold );
		return () => window.removeEventListener( 'beforeunload', hold );
	}, [ dirty ] );
}
