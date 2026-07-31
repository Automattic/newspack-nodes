import { useState, useEffect } from '@wordpress/element';
import { getStoredTheme, SKIN_EVENT } from '../shared/theme';

/**
 * Track the live page skin so a themed subtree can re-resolve theme-derived CSS
 * tokens when the shared skin owner changes it. `applySkin()` emits SKIN_EVENT
 * for both same-window changes and cross-window storage synchronization.
 *
 * @return {string} The live skin slug; changes trigger a re-render.
 */
export function useThemeToken() {
	const [ token, setToken ] = useState( getStoredTheme );

	useEffect( () => {
		const onSkin = ( event ) => setToken( event.detail );
		window.addEventListener( SKIN_EVENT, onSkin );

		return () => window.removeEventListener( SKIN_EVENT, onSkin );
	}, [] );

	return token;
}
