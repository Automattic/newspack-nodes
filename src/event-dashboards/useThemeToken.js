/**
 * Give a React subtree a value that changes when the page skin changes, so a
 * chart that resolved theme-derived CSS tokens while drawing redraws in the
 * new skin.
 *
 * Applying a skin swaps one class on `<html>` and touches no React state
 * (`shared/theme.js`), which is what re-skins every surface at once through
 * CSS alone. Anything holding a token's COMPUTED value instead — a d3 fill, a
 * canvas stroke — keeps the old color until some unrelated render repaints it.
 * This hook is the render that would otherwise never come.
 */
import { useState, useEffect } from '@wordpress/element';
import { getStoredTheme, SKIN_EVENT } from '../shared/theme';

/**
 * Track the live page skin.
 *
 * SKIN_EVENT is the only subscription needed, so this watches neither
 * `storage` nor the root element's class list: `applySkin()` fires the event
 * on a same-window change, and the module-level `storage` handler in
 * `shared/theme.js` routes another window's change back through `applySkin()`.
 * The initial read matches the class `initSkin()` already put on `<html>` at
 * module load, so the first render draws in the live skin rather than the
 * default.
 *
 * @return {string} The live skin slug; a change re-renders the caller.
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
