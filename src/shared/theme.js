/**
 * Shared skin storage and application. ONE `theme-<slug>` class on `<html>` is
 * the single source of truth for every surface — topology console, debug
 * overlay, sibling dashboards — so switching re-skins the whole page at once.
 * No React state holds the skin, no per-surface wrapper class can desync, and
 * a page behind an overlay cannot show a different skin than the overlay,
 * because there is only ever one skin and it sits on the root.
 *
 * The token CSS lives in `theme/_skins.scss`, which targets both the topology
 * and the non-layout skin roots; graph-only artwork lives in
 * `topology-console/styles/graph-view.scss`.
 *
 * The stored slug, the exact slug list and the root class live in the
 * dependency-free `skinStore.js`, which the head script is built from, so the
 * page and this module apply the skin one way.
 *
 * Consumers import this through the `@newspack-nodes/shared/theme` alias. The
 * topology console's `themes.js` re-exports the four entry points it uses and
 * adds its own console-only collapse-state keys.
 *
 * The `typeof document` and `typeof window` guards are not defensive padding:
 * `skinRamps.test.js` imports THEMES under jest's `node` environment, where
 * neither global exists and the module-load side effects at the bottom still
 * run. The try/catch around storage is a separate concern — a browser can
 * refuse `localStorage` outright.
 */
import { __ } from '@wordpress/i18n';
import {
	DEFAULT_THEME,
	SKIN_EVENT,
	THEME_SLUGS,
	THEME_STORAGE_KEY,
	clearRootThemeClass,
	getStoredTheme,
	initSkin,
	isValidTheme,
	setRootThemeClass,
} from './skinStore';

export {
	DEFAULT_THEME,
	SKIN_EVENT,
	THEME_STORAGE_KEY,
	getStoredTheme,
	initSkin,
	isValidTheme,
};

/** Each skin's name in the picker, by slug. */
const LABELS = {
	newspack: __( 'Newspack', 'newspack-nodes' ),
	'newspack-brand': __( 'Newspack Brand', 'newspack-nodes' ),
	current: __( 'Drafting Plotter', 'newspack-nodes' ),
	blueprint: __( 'Cyanotype Blueprint', 'newspack-nodes' ),
	crt: __( 'CRT Phosphor Terminal', 'newspack-nodes' ),
	'crt-color': __( 'CRT Phosphor Terminal (true color)', 'newspack-nodes' ),
	swiss: __( 'Swiss Brutalist', 'newspack-nodes' ),
	synthwave: __( 'Synthwave Outrun', 'newspack-nodes' ),
	nord: __( 'Nord Frost', 'newspack-nodes' ),
	aurora: __( 'Aurora Glass', 'newspack-nodes' ),
	solarized: __( 'Solarized Workshop', 'newspack-nodes' ),
	botanical: __( 'Botanical Naturalist', 'newspack-nodes' ),
	bauhaus: __( 'Bauhaus Constructivist', 'newspack-nodes' ),
	neotokyo: __( 'Neo-Tokyo HUD', 'newspack-nodes' ),
	pastel: __( 'Pastel Toy', 'newspack-nodes' ),
	scada: __( 'Control-Room SCADA', 'newspack-nodes' ),
};

/**
 * The skin registry — every selectable skin, in picker order.
 */
export const THEMES = THEME_SLUGS.map( ( slug ) => ( {
	slug,
	label: LABELS[ slug ],
} ) );

/**
 * Make `slug` the live skin: set the single `theme-<slug>` class on `<html>`,
 * persist it, and announce it on SKIN_EVENT. This is the ONLY operation that
 * changes a skin, and every surface re-skins from that one class through CSS
 * alone, with no React re-render. An unknown slug coerces to the default.
 *
 * Refused storage still leaves the class applied, so a private-mode or
 * over-quota browser gets the skin it asked for and simply forgets it.
 *
 * @param {string} slug Skin slug to make live.
 * @return {string} The applied slug, after validation.
 */
export function applySkin( slug ) {
	const next = isValidTheme( slug ) ? slug : DEFAULT_THEME;
	setRootThemeClass( next );
	try {
		window.localStorage.setItem( THEME_STORAGE_KEY, next );
	} catch ( _err ) {
		// Persistence unavailable (private mode/quota); class still applied.
	}
	if ( typeof window !== 'undefined' && window.dispatchEvent ) {
		window.dispatchEvent( new CustomEvent( SKIN_EVENT, { detail: next } ) );
	}
	return next;
}

/**
 * Strip every `theme-*` class off `<html>` so a suite starts clean. The class
 * outlives a jest module reset, so a test that skips this reads the previous
 * test's skin.
 *
 * @testonly Nothing in production calls this.
 */
export function resetSkin() {
	if ( typeof document !== 'undefined' ) {
		clearRootThemeClass( document.documentElement );
	}
}

// Another tab's write, or a full clear (key null), re-skins this one too.
if ( typeof window !== 'undefined' && window.addEventListener ) {
	window.addEventListener( 'storage', ( e ) => {
		if ( e.key && e.key !== THEME_STORAGE_KEY ) {
			return;
		}
		applySkin( getStoredTheme() );
	} );
}

// Re-apply at load; the head script painted it before first paint.
if ( typeof document !== 'undefined' ) {
	initSkin();
}
