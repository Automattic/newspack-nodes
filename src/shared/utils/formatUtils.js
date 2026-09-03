/**
 * The color and readout vocabulary the dashboards share: event and hook
 * colors, HTTP status colors, duration colors and classes, and the two
 * timestamp formats. Rendering all of them through one module is what keeps a
 * 5xx bar, a `sql:` span and a slow-request cell reading the same in the
 * topology console, the event dashboards and every consuming plugin.
 *
 * Every color here is a literal hex, and skin-independent by design: these
 * paint fills — chart bars, badges, flame frames — while the text colors that
 * follow the theme live in the SCSS tokens. `getTextColor` is how a label
 * stays legible on a fill this module hands out.
 */

/**
 * The hook-categorization config an application inlines before its dashboard
 * bundles run (event-logger-nodes writes it from `hook_categories.json`). Both
 * halves are keyed by category name and must agree: a category with patterns
 * but no color contributes nothing.
 *
 * @typedef {Object} HookCategories
 * @property {Object<string,string[]>} [_patterns] Regex sources per category.
 * @property {Object<string,string>}   [_colors]   Hex color per category.
 */

/**
 * `window` carrying the color config PHP inlines before any bundle runs. Both
 * globals are absent on a page that enqueued a bundle without them, and on
 * every consumer of this shared module that ships no hook categories at all.
 *
 * @typedef {Window & {
 *     eventLoggerHookCategories?: HookCategories,
 *     eventLoggerCustomColors?: Object<string,string>,
 * }} ColorConfigWindow
 */

/**
 * The fixed colors, keyed by the base name `getStateColor` reduces an event to.
 *
 * Two keys carry a fallback role: `hook` colors a hook no category pattern
 * claims, and `default` colors a name this table does not hold at all.
 */
const SYSTEM_COLORS = {
	process: '#FF7043',
	custom: '#FF5722',
	hook: '#66BB6A',
	plugin: '#AB47BC', // Purple for plugin timing.
	complete: '#4CAF50',
	// @longform Query and outbound-HTTP spans are named `base: detail`, so
	// they resolve here on the base. Both carry a hue of their own rather
	// than sharing `request`'s grey, which would leave the two most
	// expensive things in a trace the two least visible. HTTP takes the
	// hook categorizer's own HTTP color so a span reads like the hooks
	// around it; SQL has no category to borrow from and takes a hue the 63
	// in hook_categories.json do not use.
	sql: '#8E24AA',
	http: '#42A5F5',
	aggregate: '#9e9e9e',
	request: '#9e9e9e',
	default: '#9e9e9e',
};

/**
 * The dark ink `getTextColor` weighs against white: WordPress admin's
 * near-black, so a badge label matches the text around it.
 */
const DARK_INK = '#1e1e1e';

/**
 * Compiled hook-category patterns, built on the first lookup and never again.
 *
 * PHP inlines the categories on `window` before any bundle runs, so one build
 * per page load is correct and a later mutation of the global is not picked up.
 */
let compiledPatternsCache = null;

/**
 * The compiled hook-category patterns, compiling them on first use.
 *
 * A pattern the browser refuses to compile is dropped and the rest still
 * color what they match: an operator's category file is not worth a
 * dashboard-wide throw. Absent or half-declared config caches the empty list,
 * costing one scan rather than one per lookup.
 *
 * @return {Array<{regex: RegExp, color: string}>} Each category's patterns in
 *                                                 declaration order, paired
 *                                                 with that category's color.
 */
const getCompiledPatterns = () => {
	if ( compiledPatternsCache ) {
		return compiledPatternsCache;
	}

	compiledPatternsCache = [];
	const categories = /** @type {ColorConfigWindow} */ ( window )
		.eventLoggerHookCategories;
	if ( ! categories || ! categories._patterns || ! categories._colors ) {
		return compiledPatternsCache;
	}

	const patterns = categories._patterns;
	const colors = categories._colors;

	for ( const [ category, patternList ] of Object.entries( patterns ) ) {
		const color = colors[ category ];
		if ( color && Array.isArray( patternList ) ) {
			for ( const pattern of patternList ) {
				try {
					compiledPatternsCache.push( {
						regex: new RegExp( pattern ),
						color,
					} );
				} catch ( e ) {
					// Invalid regex, skip.
				}
			}
		}
	}

	return compiledPatternsCache;
};

/**
 * Memoized lookups from hook name to color, misses included.
 *
 * A miss caches `null` rather than nothing, which is why the read tests
 * `!== undefined`. The common case in a busy trace is a hook no category
 * claims, and rerunning every pattern against it on each row is the cost
 * worth avoiding.
 */
const hookColorCache = {};

/**
 * The category color for a hook name, matched against the compiled patterns.
 *
 * The first pattern that matches wins, so the order the categories appear in
 * decides an overlapping name.
 *
 * @param {string} hookName Hook name, with no trailing ` hook`.
 * @return {string|null} The category's color, or null when nothing matches.
 */
const getHookColor = ( hookName ) => {
	if ( hookColorCache[ hookName ] !== undefined ) {
		return hookColorCache[ hookName ];
	}

	const patterns = getCompiledPatterns();
	for ( const { regex, color } of patterns ) {
		if ( regex.test( hookName ) ) {
			hookColorCache[ hookName ] = color;
			return color;
		}
	}

	hookColorCache[ hookName ] = null;
	return null;
};

/**
 * Parse a 3- or 6-digit hex color into its channels.
 *
 * Both widths arrive — this module writes six digits and an operator's
 * category color may be three — and the leading `#` is optional. Anything
 * else, including a non-string, returns null for the caller to fall back on.
 *
 * @param {string} hex Hex color code.
 * @return {{r: number, g: number, b: number}|null} Channels, or null if unparseable.
 */
const parseHex = ( hex ) => {
	const digits = String( hex || '' ).replace( '#', '' );
	const full =
		3 === digits.length ? digits.replace( /./g, ( d ) => d + d ) : digits;
	if ( ! /^[0-9a-f]{6}$/i.test( full ) ) {
		return null;
	}
	return {
		r: parseInt( full.slice( 0, 2 ), 16 ),
		g: parseInt( full.slice( 2, 4 ), 16 ),
		b: parseInt( full.slice( 4, 6 ), 16 ),
	};
};

/**
 * A hex color as `rgba()` at the given opacity.
 *
 * An unparseable hex falls back to black rather than throwing. The callers
 * tint table rows and badges from operator-supplied colors, where a bad value
 * should cost one row its highlight and not the render.
 *
 * @param {string} hex     Hex color code.
 * @param {number} opacity Opacity value (0-1).
 * @return {string} RGBA color string.
 */
export const hexToRgba = ( hex, opacity ) => {
	const { r, g, b } = parseHex( hex ) ?? { r: 0, g: 0, b: 0 };
	return `rgba(${ r }, ${ g }, ${ b }, ${ opacity })`;
};

/**
 * WCAG relative luminance of a hex color.
 *
 * The WCAG 2 sRGB definition, which is where the constants come from: each
 * channel is linearized, then the three are weighted by how much the eye
 * takes from them. An unparseable color reads as black.
 *
 * @param {string} hex Hex color code.
 * @return {number} Relative luminance (0-1); 0 if unparseable.
 */
const relativeLuminance = ( hex ) => {
	const rgb = parseHex( hex );
	if ( ! rgb ) {
		return 0;
	}
	const channel = ( value ) => {
		const c = value / 255;
		return c <= 0.03928 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4;
	};
	return (
		0.2126 * channel( rgb.r ) +
		0.7152 * channel( rgb.g ) +
		0.0722 * channel( rgb.b )
	);
};

/**
 * Pick a legible foreground for a background color.
 *
 * Hook-category colors are operator-customizable and many are pale, so a fixed
 * white label drops to ~1.5:1 contrast. Take whichever of white and `DARK_INK`
 * holds the higher WCAG contrast ratio against the background; an unparseable
 * background takes white.
 *
 * @param {string} background Background hex color.
 * @return {string} Foreground hex color.
 */
export const getTextColor = ( background ) => {
	if ( ! parseHex( background ) ) {
		return '#ffffff';
	}

	const luminance = relativeLuminance( background );
	const onWhite = 1.05 / ( luminance + 0.05 );
	const onDark =
		( luminance + 0.05 ) / ( relativeLuminance( DARK_INK ) + 0.05 );
	return onDark > onWhite ? DARK_INK : '#ffffff';
};

/**
 * The color for an event, span or node name.
 *
 * The name reduces to a base first: a trailing ` (start)`/` (complete)` marker
 * comes off, then everything from the first colon, so `process (start)` and
 * `sql: SELECT wp_posts` resolve alongside `process` and `sql`. The base then
 * resolves in four steps — a ` hook` suffix through the category patterns and
 * `SYSTEM_COLORS.hook` behind them, a ` plugin` suffix to the plugin color, an
 * operator's `eventLoggerCustomColors` entry, and `SYSTEM_COLORS` last.
 *
 * The operator's overrides sit ahead of `SYSTEM_COLORS` and behind the two
 * suffixes, so an install can recolor `sql` or `process` without flattening
 * the per-hook categorization underneath it.
 *
 * @param {?string} name Event/node name.
 * @return {string} Hex color; an empty or unknown name takes the default grey.
 */
export const getStateColor = ( name ) => {
	if ( ! name ) {
		return SYSTEM_COLORS.default;
	}

	// Strip (start)/(complete) suffix for log entries.
	let baseName = name.replace( / \((start|complete)\)$/, '' ).trim();

	// Handle "base: label" format - extract base.
	const colonIdx = baseName.indexOf( ':' );
	if ( colonIdx > 0 ) {
		baseName = baseName.substring( 0, colonIdx ).trim();
	}

	// WordPress hooks end with " hook".
	if ( baseName.endsWith( ' hook' ) ) {
		const hookName = baseName.slice( 0, -5 );
		const hookColor = getHookColor( hookName );
		if ( hookColor ) {
			return hookColor;
		}
		return SYSTEM_COLORS.hook;
	}

	// Plugin timing events end with " plugin".
	if ( baseName.endsWith( ' plugin' ) ) {
		return SYSTEM_COLORS.plugin;
	}

	// Check custom event colors from config.
	const customColors =
		/** @type {ColorConfigWindow} */ ( window ).eventLoggerCustomColors ||
		{};
	if ( customColors[ baseName ] ) {
		return customColors[ baseName ];
	}

	return SYSTEM_COLORS[ baseName ] || SYSTEM_COLORS.default;
};

/**
 * The chart-fill colors for the four HTTP status classes and the unknown one,
 * read by every bar, dot and legend swatch that splits traffic by status.
 *
 * Fills only. Status TEXT follows the skin and lives in the SCSS tokens
 * (`$status-2xx` and its siblings in `shared/styles/_tokens.scss`); a second
 * status-text palette here is what `src/theme/__tests__/skinRamps.test.js`
 * refuses.
 */
export const STATUS_COLORS = {
	'2xx': '#4caf50', // Green - success.
	'3xx': '#64b5f6', // Blue - redirect.
	'4xx': '#ff9800', // Orange - client error.
	'5xx': '#ef5350', // Red - server error.
	unknown: '#9e9e9e', // Gray.
};

/**
 * The status class an HTTP status code falls in.
 *
 * Anything below 200 is `unknown`, which covers 1xx and the absent status a
 * request that never finished reports.
 *
 * @param {number} status HTTP status code.
 * @return {string} Category key ('2xx', '3xx', '4xx', '5xx', or 'unknown').
 */
export const getStatusCategory = ( status ) => {
	if ( status >= 500 ) {
		return '5xx';
	}
	if ( status >= 400 ) {
		return '4xx';
	}
	if ( status >= 300 ) {
		return '3xx';
	}
	if ( status >= 200 ) {
		return '2xx';
	}
	return 'unknown';
};

/**
 * The chart fill for an HTTP status code, through its status class.
 *
 * @param {number} status HTTP status code.
 * @return {string} CSS color value.
 */
export const getStatusColor = ( status ) =>
	STATUS_COLORS[ getStatusCategory( status ) ];

/**
 * The readout color for a duration: green to one second, orange from there to
 * five, red past five.
 *
 * `getDurationClass` cuts on the same two thresholds, so a colored number and
 * a classed cell describing one duration cannot disagree.
 *
 * @param {number} ms Duration in milliseconds.
 * @return {string} CSS color value.
 */
export const getDurationColor = ( ms ) => {
	if ( ms > 5000 ) {
		return '#ef5350';
	}
	if ( ms > 1000 ) {
		return '#ff9800';
	}
	return '#4caf50';
};

/**
 * The CSS class suffix for a duration, cut at the same one and five seconds
 * `getDurationColor` uses.
 *
 * @param {number} ms Duration in milliseconds.
 * @return {string} CSS class suffix ('fast', 'slow', or 'critical').
 */
export const getDurationClass = ( ms ) => {
	if ( ms > 5000 ) {
		return 'critical';
	}
	if ( ms > 1000 ) {
		return 'slow';
	}
	return 'fast';
};

/**
 * The CSS class suffix for an HTTP status code.
 *
 * An alias of `getStatusCategory`: the class suffix and the category key are
 * the same string, and the two names let a call site say which one it means
 * while the class boundaries stay written once.
 *
 * @param {number} status HTTP status code.
 * @return {string} CSS class suffix.
 */
export const getStatusClass = ( status ) => getStatusCategory( status );

/**
 * Epoch seconds → local `YYYY-MM-DD HH:MM:SS TZ`. The one formatter for
 * wall-clock timestamps that can be hours or days old (dead-letter records,
 * config-audit rows, spoke heartbeats) — a bare clock time is ambiguous there.
 *
 * @param {?number} ts Epoch seconds.
 * @return {string} Formatted string, or an em dash when ts is missing or not a
 *                  finite number.
 */
export const formatLocalDateTime = ( ts ) => {
	if ( 'number' !== typeof ts || ! Number.isFinite( ts ) ) {
		return '—';
	}
	const d = new Date( ts * 1000 );
	return `${ d.toLocaleDateString( 'en-CA' ) } ${ d.toLocaleTimeString(
		'en-US',
		{ hour12: false, timeZoneName: 'short' }
	) }`;
};

/**
 * A duration as a readout, laddered per value: microseconds below 0.1ms, two
 * decimals of milliseconds below 1ms, one decimal below a second, and seconds
 * to two decimals above that.
 *
 * Per-value laddering is what a detail panel wants and what an axis must not
 * have — `axisDuration` in `axis-ticks.js` is the version that holds one unit
 * across a whole scale.
 *
 * @param {?number} ms Milliseconds; null or undefined reads as `-`.
 * @return {string} Formatted string.
 */
export const formatDuration = ( ms ) => {
	if ( ms === null || ms === undefined ) {
		return '-';
	}
	if ( ms < 0.1 ) {
		return `${ ( ms * 1000 ).toFixed( 0 ) }us`;
	}
	if ( ms < 1 ) {
		return `${ ms.toFixed( 2 ) }ms`;
	}
	if ( ms < 1000 ) {
		return `${ ms.toFixed( 1 ) }ms`;
	}
	return `${ ( ms / 1000 ).toFixed( 2 ) }s`;
};

/**
 * A unix timestamp as a local wall clock, to the millisecond.
 *
 * Blanks rather than the epoch when there is no timestamp: a row still
 * arriving should not claim to have happened in 1970. `formatLocalDateTime`
 * is the one to reach for when the record is hours or days old.
 *
 * @param {?number} ts Unix seconds.
 * @return {string} `HH:MM:SS.mmm`, or blanks.
 */
export const formatTime = ( ts ) => {
	if ( ! ts ) {
		return '--:--:--.---';
	}
	const date = new Date( ts * 1000 );
	const h = String( date.getHours() ).padStart( 2, '0' );
	const m = String( date.getMinutes() ).padStart( 2, '0' );
	const s = String( date.getSeconds() ).padStart( 2, '0' );
	const ms = String( date.getMilliseconds() ).padStart( 3, '0' );
	return `${ h }:${ m }:${ s }.${ ms }`;
};
