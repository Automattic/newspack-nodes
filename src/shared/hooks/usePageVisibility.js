/**
 * Page Visibility Hook
 *
 * Tracks whether the page/tab is visible to pause refreshes when hidden.
 */

import { useState, useEffect } from '@wordpress/element';

/**
 * Hook to track page visibility state.
 *
 * @return {boolean} True if page is visible, false if hidden.
 */
export default function usePageVisibility() {
	const [ isVisible, setIsVisible ] = useState(
		() => document.visibilityState === 'visible'
	);

	useEffect( () => {
		const handleVisibilityChange = () => {
			setIsVisible( document.visibilityState === 'visible' );
		};

		document.addEventListener( 'visibilitychange', handleVisibilityChange );
		return () =>
			document.removeEventListener(
				'visibilitychange',
				handleVisibilityChange
			);
	}, [] );

	return isVisible;
}
