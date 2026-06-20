import {
	flushSync,
	useCallback,
	useEffect,
	useState,
} from '@wordpress/element';
import {
	DEFAULT_THEME,
	isValidTheme,
	THEME_STORAGE_KEY,
	INSPECTOR_COLLAPSED_STORAGE_KEY,
} from '../themes';
import withViewTransition from '../withViewTransition';

// Read the persisted skin; unknown/absent/disabled storage falls back to default.
function readStoredTheme() {
	try {
		const slug = window.localStorage.getItem( THEME_STORAGE_KEY );
		return isValidTheme( slug ) ? slug : DEFAULT_THEME;
	} catch ( _err ) {
		return DEFAULT_THEME;
	}
}

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
	const [ theme, setTheme ] = useState( readStoredTheme );
	const onThemeChange = useCallback( ( slug ) => {
		const next = isValidTheme( slug ) ? slug : DEFAULT_THEME;
		// Crossfade the skin swap; flushSync commits the new theme class
		// before the transition snapshots the "after" frame.
		withViewTransition( () => flushSync( () => setTheme( next ) ) );
		try {
			window.localStorage.setItem( THEME_STORAGE_KEY, next );
		} catch ( _err ) {
			// localStorage disabled/quota'd; in-session only.
		}
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
