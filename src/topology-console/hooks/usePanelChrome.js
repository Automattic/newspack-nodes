import {
	flushSync,
	useCallback,
	useEffect,
	useState,
} from '@wordpress/element';
import { INSPECTOR_COLLAPSED_STORAGE_KEY } from '../themes';
import { useThemeValue } from '@newspack-nodes/shared/useTheme';
import { setTheme } from '@newspack-nodes/shared/theme';
import withViewTransition from '../withViewTransition';

// Stored '0' = open, '1' = collapsed; absent/disabled storage uses the default.
function readStoredPaletteCollapsed( key, def ) {
	try {
		const stored = window.localStorage.getItem( key );
		if ( '0' === stored ) {
			return false;
		}
		if ( '1' === stored ) {
			return true;
		}
		return def;
	} catch ( _err ) {
		return def;
	}
}

// A boolean collapse-state persisted to a localStorage key ('0' open / '1'
// collapsed). Returns [value, toggle]; the palette + inspector share the recipe.
function usePersistedCollapse( key, def ) {
	const [ value, setValue ] = useState( () =>
		readStoredPaletteCollapsed( key, def )
	);
	const toggle = useCallback( () => {
		setValue( ( prev ) => {
			const next = ! prev;
			try {
				window.localStorage.setItem( key, next ? '1' : '0' );
			} catch ( _err ) {
				// localStorage disabled/quota'd; in-session only.
			}
			return next;
		} );
	}, [ key ] );
	return [ value, setValue, toggle ];
}

/**
 * Shared panel chrome for the debug overlay and topology console: the persisted
 * theme (always the global `THEME_STORAGE_KEY`, shared across both surfaces) plus
 * the palette-collapsed toggle. The palette key is injected so the console can
 * pick the LIVE vs EDIT key by mode; the overlay (live-only) passes the LIVE key.
 *
 * @param {Object}  opts                    Options.
 * @param {string}  opts.paletteKey         localStorage key for palette-collapsed.
 * @param {boolean} [opts.defaultCollapsed] Palette default when storage is empty (live: collapsed; edit: open).
 * @return {{ theme: string, onThemeChange: Function, paletteCollapsed: boolean, togglePaletteCollapsed: Function, inspectorCollapsed: boolean, toggleInspectorCollapsed: Function }} Theme + palette + inspector chrome.
 */
export function usePanelChrome( { paletteKey, defaultCollapsed = true } ) {
	const theme = useThemeValue();
	const onThemeChange = useCallback( ( slug ) => {
		// Crossfade the swap; flushSync commits the store notify (EVERY themed
		// root re-renders in this commit) before the transition snapshots the
		// "after" frame. setTheme validates + persists + notifies.
		withViewTransition( () => flushSync( () => setTheme( slug ) ) );
	}, [] );
	const [ paletteCollapsed, setPaletteCollapsed, togglePaletteCollapsed ] =
		usePersistedCollapse( paletteKey, defaultCollapsed );
	// Reload persisted state when the key changes (console mode switch).
	useEffect( () => {
		setPaletteCollapsed(
			readStoredPaletteCollapsed( paletteKey, defaultCollapsed )
		);
	}, [ paletteKey, defaultCollapsed, setPaletteCollapsed ] );

	// Inspector collapse — a single global preference shared by the console and
	// overlay. Default collapsed (a slim rail) so it's compact until a selection
	// auto-expands it (consumers call setInspectorCollapsed(false) on select) or
	// the user expands it via the chevron.
	const [
		inspectorCollapsed,
		setInspectorCollapsed,
		toggleInspectorCollapsed,
	] = usePersistedCollapse( INSPECTOR_COLLAPSED_STORAGE_KEY, true );

	return {
		theme,
		onThemeChange,
		paletteCollapsed,
		togglePaletteCollapsed,
		inspectorCollapsed,
		setInspectorCollapsed,
		toggleInspectorCollapsed,
	};
}
