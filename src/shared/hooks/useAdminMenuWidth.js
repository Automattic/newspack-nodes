/**
 * Admin Menu Width Hook
 *
 * Tracks the WordPress admin menu width, which changes when the menu folds.
 */

import { useState, useEffect } from '@wordpress/element';

/* global MutationObserver */

/**
 * Hook to track the WordPress admin menu width.
 *
 * Reads `#adminmenuwrap.offsetWidth` on mount, then re-reads on body-class
 * mutations (the fold/unfold toggle) and on window resize.
 *
 * @return {number} Menu width in pixels; 0 while no `#adminmenuwrap` exists.
 */
export default function useAdminMenuWidth() {
	const [ menuWidth, setMenuWidth ] = useState( 0 );

	useEffect( () => {
		const updateMenuWidth = () => {
			const menu = document.getElementById( 'adminmenuwrap' );
			if ( menu ) {
				setMenuWidth( menu.offsetWidth );
			}
		};

		// Initial check.
		updateMenuWidth();

		// Watch for menu fold/unfold.
		const observer = new MutationObserver( updateMenuWidth );
		observer.observe( document.body, {
			attributes: true,
			attributeFilter: [ 'class' ],
		} );

		// Window resize.
		window.addEventListener( 'resize', updateMenuWidth );

		return () => {
			observer.disconnect();
			window.removeEventListener( 'resize', updateMenuWidth );
		};
	}, [] );

	return menuWidth;
}
