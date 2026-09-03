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

/**
 * The `localStorage` key holding the persisted skin slug. One global key
 * rather than one per surface, so a skin picked anywhere applies everywhere,
 * including in the sibling plugins that import this module.
 */
export const THEME_STORAGE_KEY = 'newspack-nodes:theme';

/**
 * The skin an unknown, absent or unreadable preference coerces to. It must be
 * a slug registered in THEMES; nothing else has token CSS behind it.
 */
export const DEFAULT_THEME = 'newspack';

/**
 * The skin registry — every selectable skin, in picker order.
 *
 * Adding a slug here without a matching token block in `theme/_skins.scss`
 * fails `src/theme/__tests__/skinRamps.test.js`, which derives its expected
 * skin list from this array and asserts each entry defines every token role.
 */
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

/** Registered slugs, computed once so `isValidTheme` is a plain lookup. */
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
 * Read the persisted skin slug. An unknown slug, an absent one, and storage
 * the browser refuses all fall back to the default. This is the restore path;
 * the LIVE skin is the `<html>` class, which `applySkin` keeps in lockstep
 * with this value.
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

/**
 * Strip every `theme-*` class off the given root element.
 *
 * The list is copied before iterating, because removing a class mutates the
 * live `classList` the loop would otherwise be walking.
 *
 * @param {HTMLElement} root Element to clear.
 */
function clearRootThemeClass( root ) {
	[ ...root.classList ]
		.filter( ( c ) => c.startsWith( 'theme-' ) )
		.forEach( ( c ) => root.classList.remove( c ) );
}

/**
 * Set the single `theme-<slug>` class on `<html>`, dropping any prior one.
 * Pure DOM: it neither persists the slug nor fires SKIN_EVENT, so `applySkin`
 * and `initSkin` share it and add only the halves they differ on.
 *
 * @param {string} slug Validated skin slug.
 */
function setRootThemeClass( slug ) {
	if ( typeof document !== 'undefined' ) {
		const root = document.documentElement;
		clearRootThemeClass( root );
		root.classList.add( `theme-${ slug }` );
	}
}

/**
 * Name of the event `applySkin` fires on `window`, carrying the applied slug
 * as its `detail`. It lets an imperative side-effect re-run without React
 * state: a chart holding a token's computed color, or a dashboard painting the
 * WP-admin gutters to the skin surface. It reaches the SAME window, which the
 * `storage` event never does — that one fires only in other tabs.
 */
export const SKIN_EVENT = 'newspack-nodes:skin';

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
 * Apply the PERSISTED skin's class to `<html>`. This is a READ, so it does not
 * re-persist — an empty preference stays empty until the user picks a skin —
 * and it fires no event, because a surface mounting into the class paints
 * itself. Each bundle calls it at load or mount so the root carries the right
 * skin before first paint.
 *
 * @return {string} The applied slug.
 */
export function initSkin() {
	const slug = getStoredTheme();
	setRootThemeClass( slug );
	return slug;
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

// Apply the persisted skin to <html> at module load — no unstyled flash.
if ( typeof document !== 'undefined' ) {
	initSkin();
}
