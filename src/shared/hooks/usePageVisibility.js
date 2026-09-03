/**
 * usePageVisibility — the one read of tab visibility every substrate poller
 * gates on, so a backgrounded tab issues no requests.
 *
 * A hidden tab's timers are throttled, not stopped, so a dashboard that
 * ignores visibility keeps polling at a degraded and jittery cadence.
 * `useBatchedPoll` and the graph hooks stop their Timer on this signal
 * instead, and re-arm it when the tab comes back.
 */

import { useLayoutEffect, useState } from '@wordpress/element';

/**
 * Reads the live visibility state.
 *
 * @return {boolean} True while `document.visibilityState` is `visible`.
 */
function getSnapshot() {
	return 'visible' === document.visibilityState;
}

/**
 * Tracks tab visibility, starting hidden and reconciling before paint.
 *
 * The initial state is `false` rather than a live read, and `useLayoutEffect`
 * settles it before React runs any passive effect. A consumer's
 * `useEffect( …, [ isVisible ] )` therefore runs once with the settled value,
 * instead of arming a poll for a tab that turned out to be hidden and tearing
 * it down again on the next pass.
 *
 * Subscribing before reading the snapshot is the other half of that: a flip
 * between render and `addEventListener` fires no event anyone is listening
 * for, so the read has to follow the listener or it is lost.
 *
 * @return {boolean} True while the tab is visible, false while it is hidden.
 */
export default function usePageVisibility() {
	const [ isVisible, setIsVisible ] = useState( false );

	useLayoutEffect( () => {
		const handleVisibilityChange = () => {
			setIsVisible( getSnapshot() );
		};

		document.addEventListener( 'visibilitychange', handleVisibilityChange );
		handleVisibilityChange();
		return () =>
			document.removeEventListener(
				'visibilitychange',
				handleVisibilityChange
			);
	}, [] );

	return isVisible;
}
