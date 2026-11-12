/**
 * The stored skin, the one `theme-<slug>` class on `<html>` and the gutter
 * paint around a skinned page, with no dependency at all, so the head script the build emits from it
 * (`src/early-skin`) and `theme.js` share one implementation and one exact
 * list of slugs. `theme.js` re-exports all of it beside the labels, the
 * live switch and the cross-tab listener.
 *
 * The `typeof document` and `typeof window` guards hold because
 * `skinRamps.test.js` imports the slugs under jest's `node` environment.
 */

/**
 * The `localStorage` key holding the persisted skin slug. One global key
 * rather than one per surface, so a skin picked anywhere applies everywhere,
 * including in the sibling plugins that import this module.
 */
export const THEME_STORAGE_KEY = 'newspack-nodes:theme';

/**
 * The skin an unknown, absent or unreadable preference coerces to. It must be
 * a slug in THEME_SLUGS; nothing else has token CSS behind it.
 */
export const DEFAULT_THEME = 'newspack';

/**
 * Every selectable skin's slug, in picker order. `theme.js` names each one
 * in THEMES, and a slug without a token block in `theme/_skins.scss` fails
 * `src/theme/__tests__/skinRamps.test.js`.
 */
export const THEME_SLUGS = [
	'newspack',
	'newspack-brand',
	'current',
	'blueprint',
	'crt',
	'crt-color',
	'swiss',
	'synthwave',
	'nord',
	'aurora',
	'solarized',
	'botanical',
	'bauhaus',
	'neotokyo',
	'pastel',
	'scada',
];

/**
 * True when `slug` is a known skin.
 *
 * @param {string} slug Candidate skin slug.
 * @return {boolean} Whether the slug matches a registered skin.
 */
export function isValidTheme( slug ) {
	return typeof slug === 'string' && THEME_SLUGS.includes( slug );
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
export function clearRootThemeClass( root ) {
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
export function setRootThemeClass( slug ) {
	if ( typeof document !== 'undefined' ) {
		const root = document.documentElement;
		clearRootThemeClass( root );
		root.classList.add( `theme-${ slug }` );
	}
}

/**
 * Apply the PERSISTED skin's class to `<html>`. This is a READ, so it does not
 * re-persist — an empty preference stays empty until the user picks a skin —
 * and it fires no event, because a surface mounting into the class paints
 * itself. The head script `src/early-skin` runs it before first paint, and
 * `theme.js` again at load, so a page that did not take the head script still
 * ends on the stored skin.
 *
 * @return {string} The applied slug.
 */
export function initSkin() {
	const slug = getStoredTheme();
	setRootThemeClass( slug );
	return slug;
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
 * The colours WordPress components paint from, which the skin root sets.
 * A menu WordPress portals straight to `<body>` reads them there.
 */
const COMPONENT_COLORS = [
	'--wp-components-color-background',
	'--wp-components-color-foreground',
	'--wp-components-color-foreground-inverted',
	'--wp-components-color-gray-300',
	'--wp-components-color-accent',
	'--wp-components-color-accent-darker-10',
	'--wp-components-color-accent-darker-20',
	'--wp-components-color-accent-inverted',
];

/**
 * Paints the WP-admin gutters around a skinned page — `document.body`'s
 * background and the WordPress component colours a menu portalled to `<body>`
 * reads — from inside the skin root `host`, now and on every `SKIN_EVENT`. It
 * applies the persisted skin to `<html>` first, because the probe reads
 * `--paper-3` through it. A server-rendered page calls it on the skin root it
 * printed; `useSkinGutters` calls it from a component.
 *
 * @param {?Element} host The skin root to resolve the tokens in.
 * @return {() => void} Stops repainting and restores `<body>`.
 */
export function paintSkinGutters( host ) {
	// The gutter probe reads --paper-3, so apply the persisted skin first.
	initSkin();
	if ( ! host ) {
		return () => {};
	}
	let previous = null;
	/**
	 * Paint `document.body` with the skin's `--paper-3`, resolved by a
	 * throwaway probe span parented INSIDE the themed wrapper — the token
	 * exists only under the skin-root selector, so a probe anywhere else
	 * reads nothing.
	 *
	 * A token that fails to resolve computes as transparent; leave the body
	 * untouched rather than paint it see-through. The first successful
	 * paint captures the pre-paint background, so an unmount that never
	 * painted restores nothing.
	 *
	 * The same probe reads the component colours the skin root sets, and
	 * `<body>` takes them, so a menu portalled there takes the skin too.
	 */
	const paintGutters = () => {
		const probe = document.createElement( 'span' );
		host.appendChild( probe );
		let paper;
		let colors;
		try {
			probe.style.background = 'var(--paper-3)';
			const style = window.getComputedStyle( probe );
			paper = style.backgroundColor;
			colors = COMPONENT_COLORS.map( ( name ) => [
				name,
				style.getPropertyValue( name ).trim(),
			] );
		} finally {
			probe.remove();
		}
		if ( ! paper || paper === 'rgba(0, 0, 0, 0)' ) {
			return;
		}
		if ( null === previous ) {
			previous = document.body.style.background;
		}
		document.body.style.background = paper;
		for ( const [ name, value ] of colors ) {
			if ( value ) {
				document.body.style.setProperty( name, value );
			} else {
				document.body.style.removeProperty( name );
			}
		}
	};
	paintGutters();
	window.addEventListener( SKIN_EVENT, paintGutters );
	return () => {
		window.removeEventListener( SKIN_EVENT, paintGutters );
		if ( null !== previous ) {
			document.body.style.background = previous;
			for ( const name of COMPONENT_COLORS ) {
				document.body.style.removeProperty( name );
			}
		}
	};
}
