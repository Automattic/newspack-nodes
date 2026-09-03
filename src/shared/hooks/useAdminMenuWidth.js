/**
 * useAdminMenuWidth — measure the WordPress admin menu so a fixed-position
 * admin UI can sit flush against it.
 *
 * A `position: fixed` element leaves the document flow, so no CSS rule can
 * hold it beside a menu that folds from 160px to 36px. The width has to reach
 * the consumer as a number it can put in `left`.
 */

import { useState, useEffect } from '@wordpress/element';

/* global MutationObserver */

/**
 * Tracks the width of `#adminmenuwrap`, re-reading it whenever the menu folds
 * or the viewport changes.
 *
 * The fold surfaces as a class flip on `<body>`, so a MutationObserver over
 * that one attribute catches both the collapse button and the responsive
 * auto-fold, without depending on jQuery's `wp-collapse-menu` event. Window
 * resize is the second signal and not a duplicate: core's media queries resize
 * the menu at narrow viewports with no class flip at all.
 *
 * The width holds its last reading while `#adminmenuwrap` is absent, so a
 * consumer keeps the layout it has rather than snapping to the left edge.
 *
 * @return {number} Menu width in pixels; 0 until an `#adminmenuwrap` is found.
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

		updateMenuWidth();

		const observer = new MutationObserver( updateMenuWidth );
		observer.observe( document.body, {
			attributes: true,
			attributeFilter: [ 'class' ],
		} );

		window.addEventListener( 'resize', updateMenuWidth );

		return () => {
			observer.disconnect();
			window.removeEventListener( 'resize', updateMenuWidth );
		};
	}, [] );

	return menuWidth;
}
