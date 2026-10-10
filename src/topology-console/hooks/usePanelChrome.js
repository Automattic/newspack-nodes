/**
 * usePanelChrome — the collapse state of the two panels flanking a
 * ConsoleShell: the class palette and the node inspector. The topology console
 * and the debug overlay both mount that shell, and this hook is where they
 * share one implementation instead of keeping two.
 *
 * Each preference outlives the page in localStorage, and the two differ in
 * scope. The palette key arrives as a parameter, so the console hands over its
 * EDIT key or its LIVE key as the mode changes and each mode keeps its own
 * answer, while the overlay — live canvas only — always passes the LIVE key.
 * The inspector reads one key on every surface, because a reader who opens it
 * wants it open wherever the shell appears. `setInspectorCollapsed` stores
 * nothing, so selecting a node opens the inspector without overwriting what
 * the reader last chose; only the toggles store.
 *
 * The skin is not part of this chrome. It is the global `<html>.theme-<slug>`
 * class that `applySkin` sets, in `src/shared/theme.js`.
 */

import { INSPECTOR_COLLAPSED_STORAGE_KEY } from '../themes';
import { usePersistedFlag } from '../../shared/hooks/usePersistedState';

/**
 * Own the palette and inspector collapse state for one ConsoleShell.
 *
 * @param {Object}  opts                    Options.
 * @param {string}  opts.paletteKey         Storage key for the palette flag; the console swaps it per mode.
 * @param {boolean} [opts.defaultCollapsed] Palette state when storage holds no answer. The overlay and the console's view mode start collapsed; edit mode starts open, where the palette is the source of new nodes.
 * @return {{paletteCollapsed: boolean, togglePaletteCollapsed: () => void, inspectorCollapsed: boolean, setInspectorCollapsed: import('react').Dispatch<import('react').SetStateAction<boolean>>, toggleInspectorCollapsed: () => void}} Palette and inspector chrome.
 */
export function usePanelChrome( { paletteKey, defaultCollapsed = true } ) {
	const [ paletteCollapsed, , togglePaletteCollapsed ] = usePersistedFlag(
		paletteKey,
		defaultCollapsed
	);

	const [
		inspectorCollapsed,
		setInspectorCollapsed,
		toggleInspectorCollapsed,
	] = usePersistedFlag( INSPECTOR_COLLAPSED_STORAGE_KEY, true );

	return {
		paletteCollapsed,
		togglePaletteCollapsed,
		inspectorCollapsed,
		setInspectorCollapsed,
		toggleInspectorCollapsed,
	};
}
