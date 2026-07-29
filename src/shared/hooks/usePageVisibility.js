/**
 * Page Visibility Hook
 *
 * Tracks whether the page/tab is visible to pause refreshes when hidden.
 */

import { useLayoutEffect, useState } from '@wordpress/element';

function getSnapshot() {
	return 'visible' === document.visibilityState;
}

/**
 * Hook to track page visibility state.
 *
 * @return {boolean} True if page is visible, false if hidden.
 */
export default function usePageVisibility() {
	// Hidden until the layout subscription reconciles the live snapshot.
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
