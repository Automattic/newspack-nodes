/**
 * Format utilities for dashboards.
 */

/**
 * The hook-categorization config an application inlines before its dashboard
 * bundles run (event-logger-nodes writes it from `hook_categories.json`). Both
 * halves are keyed by category name and must agree: a category with patterns
 * but no color contributes nothing.
 *
 * @typedef {Object} HookCategories
 * @property {Object<string, string[]>} [_patterns] Regex sources per category.
 * @property {Object<string, string>}   [_colors]   Hex color per category.
 */

/**
 * `window` carrying the color config PHP inlines before any bundle runs. Both
 * globals are absent on a page that enqueued a bundle without them, and on
 * every consumer of this shared module that ships no hook categories at all.
 *
 * @typedef {Window & {
 *     eventLoggerHookCategories?: HookCategories,
 *     eventLoggerCustomColors?: Object<string, string>,
 * }} ColorConfigWindow
 */

/**
 * System-level colors for events.
 */
const SYSTEM_COLORS = {
	process: '#FF7043',
	custom: '#FF5722',
	hook: '#66BB6A',
	plugin: '#AB47BC', // Purple for plugin timing.
	complete: '#4CAF50',
	// @longform Query and outbound-HTTP spans are named `base: detail`, so they
	// resolve here on the base — and both fell through to `request`'s grey,
	// which left the two most expensive things in a trace the two least
	// visible. HTTP takes the hook categorizer's own HTTP color so a span reads
	// like the hooks around it; SQL has no category to borrow from and takes a
	// hue the 63 in hook_categories.json do not use.
	sql: '#8E24AA',
	http: '#42A5F5',
	aggregate: '#9e9e9e',
	request: '#9e9e9e',
	default: '#9e9e9e',
};

/**
 * Dark badge ink, the alternative to white.
 */
const DARK_INK = '#1e1e1e';

/**
 * Compiled regex patterns for hook categorization (built lazily).
 */
let compiledPatternsCache = null;
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
 * Cache for hook→color lookups.
 */
const hookColorCache = {};

/**
 * Get color for a hook name using pattern matching.
 *
 * @param {string} hookName Hook name to look up.
 * @return {string|null} Color or null if no match.
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
 * Convert hex color to RGBA with opacity.
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
 * white label drops to ~1.5:1 contrast. Choose whichever ink wins on WCAG
 * relative luminance.
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
 * Get color for a state/event/node.
 *
 * @param {string} name Event/node name.
 * @return {string} Hex color.
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
 * Status code color palette - single source of truth.
 */
export const STATUS_COLORS = {
	'2xx': '#4caf50', // Green - success.
	'3xx': '#64b5f6', // Blue - redirect.
	'4xx': '#ff9800', // Orange - client error.
	'5xx': '#ef5350', // Red - server error.
	unknown: '#9e9e9e', // Gray.
};

/**
 * Get status category string from HTTP status code.
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
 * Get color for HTTP status code.
 *
 * @param {number} status HTTP status code.
 * @return {string} CSS color value.
 */
export const getStatusColor = ( status ) =>
	STATUS_COLORS[ getStatusCategory( status ) ];

/**
 * Get color for duration based on value.
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
 * Get CSS class suffix for duration based on value.
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
 * Get CSS class suffix for HTTP status code.
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
 * @param {number} ts Epoch seconds.
 * @return {string} Formatted string, or an em dash for a non-finite ts.
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
 * Format a duration in milliseconds.
 *
 * @param {number} ms Milliseconds.
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
