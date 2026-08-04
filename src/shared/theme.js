/**
 * Shared skin storage + application. ONE `theme-<slug>` class on `<html>` is the
 * single source of truth for every surface (topology console, debug overlay,
 * sibling dashboards). Switching re-skins the WHOLE page at once, atomically —
 * there is no React state for the skin, no per-surface wrapper class to desync,
 * no store to tear, and no way for a page-behind an overlay to hold a different
 * skin (there is only ever ONE skin, on the root).
 *
 * The token CSS lives in `theme/_skins.scss` and targets both topology and
 * non-layout skin roots. Graph-only artwork remains in
 * `topology-console/styles/graph-view.scss`.
 *
 * Consumers import this via the `@newspack-nodes/shared/theme` alias; the
 * topology-console's `themes.js` re-exports everything here and adds its own
 * console-only collapse-state keys.
 */
import { __ } from '@wordpress/i18n';

// Global storage key shared by every surface so a skin applies everywhere.
export const THEME_STORAGE_KEY = 'newspack-nodes:theme';

export const DEFAULT_THEME = 'newspack';

export const THEMES = [
	{ slug: 'newspack', label: __( 'Newspack', 'newspack-nodes' ) },
	{ slug: 'newspack-brand', label: __( 'Newspack Brand', 'newspack-nodes' ) },
	{ slug: 'current', label: __( 'Drafting Plotter', 'newspack-nodes' ) },
	{
		slug: 'blueprint',
		label: __( 'Cyanotype Blueprint', 'newspack-nodes' ),
	},
	{ slug: 'crt', label: __( 'CRT Phosphor Terminal', 'newspack-nodes' ) },
	{ slug: 'swiss', label: __( 'Swiss Brutalist', 'newspack-nodes' ) },
	{ slug: 'synthwave', label: __( 'Synthwave Outrun', 'newspack-nodes' ) },
	{ slug: 'nord', label: __( 'Nord Frost', 'newspack-nodes' ) },
	{ slug: 'aurora', label: __( 'Aurora Glass', 'newspack-nodes' ) },
	{
		slug: 'solarized',
		label: __( 'Solarized Workshop', 'newspack-nodes' ),
	},
	{
		slug: 'botanical',
		label: __( 'Botanical Naturalist', 'newspack-nodes' ),
	},
	{
		slug: 'bauhaus',
		label: __( 'Bauhaus Constructivist', 'newspack-nodes' ),
	},
	{ slug: 'neotokyo', label: __( 'Neo-Tokyo HUD', 'newspack-nodes' ) },
	{ slug: 'pastel', label: __( 'Pastel Toy', 'newspack-nodes' ) },
	{ slug: 'scada', label: __( 'Control-Room SCADA', 'newspack-nodes' ) },
];

const SLUGS = THEMES.map( ( t ) => t.slug );

/**
 * True when `slug` is a known skin.
 *
 * @param {string} slug Candidate skin slug.
 * @return {boolean} Whether the slug matches a registered skin.
 */
export function isValidTheme( slug ) {
	return typeof slug === 'string' && SLUGS.includes( slug );
}

/**
 * Read the persisted skin slug — unknown/absent/disabled storage falls back to
 * the default. This is the restore/read source; the LIVE skin is the `<html>`
 * class, which `applySkin` keeps in lockstep with this value.
 *
 * @return {string} The persisted skin slug, or DEFAULT_THEME.
 */
export function getStoredTheme() {
	try {
		const slug = window.localStorage.getItem( THEME_STORAGE_KEY );
		return isValidTheme( slug ) ? slug : DEFAULT_THEME;
	} catch ( _err ) {
		return DEFAULT_THEME;
	}
}

// Strip any `theme-*` class off the given root element.
function clearRootThemeClass( root ) {
	[ ...root.classList ]
		.filter( ( c ) => c.startsWith( 'theme-' ) )
		.forEach( ( c ) => root.classList.remove( c ) );
}

// Set the single `theme-<slug>` class on <html>. Pure DOM — no persistence.
function setRootThemeClass( slug ) {
	if ( typeof document !== 'undefined' ) {
		const root = document.documentElement;
		clearRootThemeClass( root );
		root.classList.add( `theme-${ slug }` );
	}
}

/**
 * Fired on `window` after every skin change, `detail` = the applied slug. Lets
 * imperative side-effects (e.g. a dashboard painting the WP-admin gutters to the
 * skin surface) re-run without React state — same-tab, unlike the `storage`
 * event, which only reaches OTHER tabs.
 */
export const SKIN_EVENT = 'newspack-nodes:skin';

/**
 * Make `slug` the live skin: set the single `theme-<slug>` class on `<html>`
 * (dropping any prior one) and persist it. This is the ONLY operation that
 * changes a skin — every surface re-skins from this one class via CSS, no React
 * re-render required. Unknown slugs coerce to the default.
 *
 * @param {string} slug Skin slug to make live.
 * @return {string} The applied slug (after validation).
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
 * Apply the PERSISTED skin's class to `<html>` — a READ, so it does NOT
 * re-persist (an empty preference stays empty until the user picks a skin) and
 * fires no event (a mounting surface paints itself directly). Each bundle calls
 * this at load/mount so the root carries the right skin before first paint.
 *
 * @return {string} The applied slug.
 */
export function initSkin() {
	const slug = getStoredTheme();
	setRootThemeClass( slug );
	return slug;
}

/**
 * Test seam: strip any `theme-*` class off `<html>` so a suite starts clean.
 * Not used in production.
 */
export function resetSkin() {
	if ( typeof document !== 'undefined' ) {
		clearRootThemeClass( document.documentElement );
	}
}

// Cross-tab storage event: re-apply so every open surface stays in sync.
if ( typeof window !== 'undefined' && window.addEventListener ) {
	window.addEventListener( 'storage', ( e ) => {
		if ( e.key && e.key !== THEME_STORAGE_KEY ) {
			return;
		}
		applySkin( getStoredTheme() );
	} );
}

// Apply the persisted skin to <html> at module load — no unstyled flash.
if ( typeof document !== 'undefined' ) {
	initSkin();
}
