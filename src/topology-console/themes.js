/**
 * Topology Console skins. `current` is the default (identity) skin; the
 * others map to `.topology-app.theme-<slug>` override blocks in
 * styles/topology-console.scss.
 */
export const DEFAULT_THEME = 'current';

export const THEMES = [
	{ slug: 'current', label: 'Current — Drafting Plotter' },
	{ slug: 'blueprint', label: 'Cyanotype Blueprint' },
	{ slug: 'crt', label: 'CRT Phosphor Terminal' },
	{ slug: 'swiss', label: 'Swiss Brutalist' },
	{ slug: 'synthwave', label: 'Synthwave Outrun' },
	{ slug: 'nord', label: 'Nord Frost' },
	{ slug: 'aurora', label: 'Aurora Glass' },
	{ slug: 'solarized', label: 'Solarized Workshop' },
	{ slug: 'botanical', label: 'Botanical Naturalist' },
	{ slug: 'bauhaus', label: 'Bauhaus Constructivist' },
	{ slug: 'neotokyo', label: 'Neo-Tokyo HUD' },
	{ slug: 'pastel', label: 'Pastel Toy' },
	{ slug: 'scada', label: 'Control-Room SCADA' },
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
