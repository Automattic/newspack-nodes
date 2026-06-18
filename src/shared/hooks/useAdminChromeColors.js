/**
 * Reads the active WordPress admin color scheme's chrome colors off the live
 * admin bar, so DevTools chrome (the hub tab bar) blends with whatever scheme
 * the user picked — Fresh, Coffee, Ectoplasm, a custom one — instead of a
 * hardcoded dark strip. Falls back to the supplied colors when the admin bar
 * isn't in the DOM (the standalone overlay, tests).
 *
 * @param {Object} fallback            Colors to use when the admin bar is absent.
 * @param {string} fallback.background Default chrome background.
 * @param {string} fallback.foreground Default chrome text color.
 * @return {{background: string, foreground: string}} Resolved chrome colors.
 */
import { useState, useEffect } from '@wordpress/element';

/* global MutationObserver */

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

export default function useAdminChromeColors(
	fallback = { background: '#1e1e1e', foreground: '#ffffff' }
) {
	const [ colors, setColors ] = useState( fallback );
	const { background: fbBg, foreground: fbFg } = fallback;

	useEffect( () => {
		const read = () => {
			// The admin bar carries the scheme's base color in every built-in
			// scheme; the menu is the fallback for the rare bar-less screen.
			const el =
				document.getElementById( 'wpadminbar' ) ||
				document.getElementById( 'adminmenuback' ) ||
				document.getElementById( 'adminmenu' );
			if ( ! el ) {
				setColors( { background: fbBg, foreground: fbFg } );
				return;
			}
			const cs = window.getComputedStyle( el );
			setColors( {
				background:
					cs.backgroundColor && cs.backgroundColor !== TRANSPARENT
						? cs.backgroundColor
						: fbBg,
				foreground:
					cs.color && cs.color !== TRANSPARENT ? cs.color : fbFg,
			} );
		};

		read();

		// The scheme can change without a reload (e.g. profile preview toggles a
		// body class); re-read cheaply when it does.
		const observer = new MutationObserver( read );
		observer.observe( document.body, {
			attributes: true,
			attributeFilter: [ 'class' ],
		} );

		return () => observer.disconnect();
	}, [ fbBg, fbFg ] );

	return colors;
}
