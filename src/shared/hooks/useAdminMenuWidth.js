/**
 * Custom hook to track WordPress admin menu width.
 *
 * @return {number} Current menu width in pixels.
 */
import { useState, useEffect } from '@wordpress/element';

/* global MutationObserver */

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
