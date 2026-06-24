import { useState, useEffect } from '@wordpress/element';
import { getStoredTheme, THEME_STORAGE_KEY } from '../topology-console/themes';

/**
 * Track the live hub skin so a themed subtree can re-resolve theme-derived CSS
 * tokens when the skin changes. The skin is the existing `THEME_STORAGE_KEY`
 * preference, applied to the DOM as a `theme-<slug>` class on the `.topology-app`
 * token-context root above the caller. We watch both signals that move it:
 * the `storage` event (a skin picked in another tab) and a `MutationObserver` on
 * the themed ancestor's `class` (an in-window `set_skin`, which re-renders the
 * parent — not this memoized subtree — and swaps that class).
 *
 * @param {{ current: ?Element }} ref Ref to an element inside the themed root.
 * @return {string} The live skin slug; changes trigger a re-render.
 */
export function useThemeToken( ref ) {
	const [ token, setToken ] = useState( getStoredTheme );

	useEffect( () => {
		const sync = () => setToken( getStoredTheme() );

		const onStorage = ( e ) => {
			if ( ! e.key || THEME_STORAGE_KEY === e.key ) {
				sync();
			}
		};
		window.addEventListener( 'storage', onStorage );

		const root = ref.current?.closest( '.topology-app' );
		let observer;
		if ( root ) {
			observer = new window.MutationObserver( sync );
			observer.observe( root, {
				attributes: true,
				attributeFilter: [ 'class' ],
			} );
		}

		// The ancestor class may already differ from the seeded value by the
		// time the effect runs (mount-time skin swap); reconcile once.
		sync();

		return () => {
			window.removeEventListener( 'storage', onStorage );
			observer?.disconnect();
		};
	}, [ ref ] );

	return token;
}
