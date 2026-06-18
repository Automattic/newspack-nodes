/**
 * Topology Console skins. `newspack` is the default skin; every skin maps to a
 * `.topology-app.theme-<slug>` override block in styles/graph-view.scss, except
 * `current` (the identity skin), which renders from the base token values.
 */
import { __ } from '@wordpress/i18n';

// Global storage keys shared by topology-console + debug-overlay so a
// preference picked in either surface applies in both.
export const THEME_STORAGE_KEY = 'newspack-nodes:theme';
// Palette collapse state is stored per-mode (live vs edit) because the
// two surfaces want different defaults: live defaults to collapsed
// (the palette isn't needed when watching), edit defaults to open (you
// drop nodes from it onto the canvas). The DebugOverlay only ever runs
// in live mode and so reads/writes the live key.
export const PALETTE_COLLAPSED_STORAGE_KEY_LIVE =
	'newspack-nodes:palette-collapsed:live';
export const PALETTE_COLLAPSED_STORAGE_KEY_EDIT =
	'newspack-nodes:palette-collapsed:edit';

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
