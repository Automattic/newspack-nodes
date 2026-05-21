/**
 * Format utilities for dashboards.
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
	aggregate: '#9e9e9e',
	request: '#9e9e9e',
	default: '#9e9e9e',
};

/**
 * Compiled regex patterns for hook categorization (built lazily).
 */
let compiledPatternsCache = null;
const getCompiledPatterns = () => {
	if ( compiledPatternsCache ) {
		return compiledPatternsCache;
	}

	compiledPatternsCache = [];
	const categories = window.eventLoggerHookCategories;
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
 * Convert hex color to RGBA with opacity.
 *
 * @param {string} hex     Hex color code.
 * @param {number} opacity Opacity value (0-1).
 * @return {string} RGBA color string.
 */
export const hexToRgba = ( hex, opacity ) => {
	const r = parseInt( hex.slice( 1, 3 ), 16 );
	const g = parseInt( hex.slice( 3, 5 ), 16 );
	const b = parseInt( hex.slice( 5, 7 ), 16 );
	return `rgba(${ r }, ${ g }, ${ b }, ${ opacity })`;
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
	const customColors = window.eventLoggerCustomColors || {};
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
