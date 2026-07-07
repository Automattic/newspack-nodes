/**
 * Shared theme-storage helpers. The canonical source for "which skin is live"
 * — the persisted slug, the skin catalog, and the validation/read helpers.
 *
 * Lives in src/shared so sibling consumers (event-logger-nodes, pyrobase) can
 * import the SAME storage contract via the `@newspack-nodes/shared/theme`
 * alias, applying a console-selected skin to their standalone dashboards. The
 * topology-console's `themes.js` re-exports everything here and adds its own
 * console-only collapse-state keys; it does NOT import back into this module
 * (no circular dependency).
 *
 * Each skin maps to a `.topology-app.theme-<slug>` override block in the
 * topology-console's styles/graph-view.scss, except `current` (the identity
 * skin), which renders from the base token values.
 */
import { __ } from '@wordpress/i18n';

// Global storage key shared by topology-console + debug-overlay + sibling
// dashboards so a preference picked in any surface applies in all of them.
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
 * Read the persisted skin slug. The single source of truth for "which skin is
 * live" — unknown/absent/disabled storage falls back to the default. Reading it
 * fresh at call time (rather than threading the reactive `theme`) lets the
 * `list_skins` builtin mark the current skin without closure staleness.
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

// Reactive layer so a `set_skin` on ANY surface re-renders EVERY themed root at
// once — the overlay's wrappers and the page behind it — with no per-surface
// mirror to lag or bleed. `subscribeTheme` + `readTheme` are the
// `useSyncExternalStore` pair.
const listeners = new Set();

// The LIVE slug: the in-memory source of truth for the current window. Lazily
// seeded from the persisted slug on first read and cached, so the
// `useSyncExternalStore` snapshot is a cheap field read (not a localStorage hit)
// on every render. `setTheme` sets it INDEPENDENTLY of persistence, so a skin
// change applies even when `localStorage.setItem` throws (private mode / quota).
// localStorage is only the persisted copy (which may lag if a write fails);
// `getStoredTheme` reads THAT and is for restore/cross-tab, not "what's live".
let current;

/**
 * Snapshot for `useSyncExternalStore`: the live slug. A stable string between
 * notifications (seeded once, then mutated only by `setTheme` / the cross-tab
 * sync, both of which notify).
 *
 * @return {string} The live skin slug.
 */
export function readTheme() {
	if ( current === undefined ) {
		current = getStoredTheme();
	}
	return current;
}

/**
 * Subscribe to skin changes (for `useSyncExternalStore`).
 *
 * @param {Function} listener Called (no args) after every change.
 * @return {Function} Unsubscribe.
 */
export function subscribeTheme( listener ) {
	listeners.add( listener );
	return () => listeners.delete( listener );
}

function notify() {
	for ( const listener of listeners ) {
		listener();
	}
}

/**
 * Make a skin live: set the in-memory value, persist it (best-effort), and
 * notify every subscriber in the same window. Unknown slugs coerce to default.
 *
 * @param {string} slug Skin slug to make live.
 */
export function setTheme( slug ) {
	current = isValidTheme( slug ) ? slug : DEFAULT_THEME;
	try {
		window.localStorage.setItem( THEME_STORAGE_KEY, current );
	} catch ( _err ) {
		// Persistence unavailable; the in-memory value still drives this window.
	}
	notify();
}

// Cross-tab: another tab persisting a skin fires `storage` here (never in the
// origin tab). Adopt it + notify so every subscriber re-skins live, matching the
// in-window path. Same-tab writes go through setTheme, which already notified.
if ( typeof window !== 'undefined' && window.addEventListener ) {
	window.addEventListener( 'storage', ( e ) => {
		if ( e.key && e.key !== THEME_STORAGE_KEY ) {
			return;
		}
		const stored = getStoredTheme();
		if ( stored !== current ) {
			current = stored;
			notify();
		}
	} );
}

/**
 * Test seam: drop the live value + all subscribers so this module's singleton
 * state can't leak across tests. Not used in production.
 */
export function resetThemeStore() {
	current = undefined;
	listeners.clear();
}
