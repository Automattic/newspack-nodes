/**
 * Tests for the dashboard format utilities (color/class lookups, hex->rgba, formatDuration, getStateColor).
 */

import {
	STATUS_COLORS,
	formatDuration,
	getDurationClass,
	getDurationColor,
	getStateColor,
	getStatusCategory,
	getStatusClass,
	getStatusColor,
	hexToRgba,
} from '../formatUtils';

describe( 'hexToRgba', () => {
	it( 'converts a 6-digit hex to rgba()', () => {
		expect( hexToRgba( '#FF0080', 0.5 ) ).toBe( 'rgba(255, 0, 128, 0.5)' );
	} );

	it( 'converts black with full opacity', () => {
		expect( hexToRgba( '#000000', 1 ) ).toBe( 'rgba(0, 0, 0, 1)' );
	} );
} );

describe( 'getStatusCategory', () => {
	it.each( [
		[ 100, 'unknown' ],
		[ 199, 'unknown' ],
		[ 200, '2xx' ],
		[ 204, '2xx' ],
		[ 299, '2xx' ],
		[ 301, '3xx' ],
		[ 399, '3xx' ],
		[ 404, '4xx' ],
		[ 499, '4xx' ],
		[ 500, '5xx' ],
		[ 599, '5xx' ],
	] )( '%s -> %s', ( status, expected ) => {
		expect( getStatusCategory( status ) ).toBe( expected );
	} );
} );

describe( 'getStatusColor / getStatusClass', () => {
	it( 'getStatusColor maps to STATUS_COLORS entry', () => {
		expect( getStatusColor( 200 ) ).toBe( STATUS_COLORS[ '2xx' ] );
		expect( getStatusColor( 503 ) ).toBe( STATUS_COLORS[ '5xx' ] );
	} );

	it( 'getStatusClass alias returns the category key', () => {
		expect( getStatusClass( 404 ) ).toBe( '4xx' );
	} );
} );

describe( 'getDurationColor / getDurationClass', () => {
	it.each( [
		[ 10, '#4caf50', 'fast' ],
		[ 999, '#4caf50', 'fast' ],
		[ 1001, '#ff9800', 'slow' ],
		[ 5000, '#ff9800', 'slow' ],
		[ 5001, '#ef5350', 'critical' ],
	] )( '%sms -> %s / %s', ( ms, color, klass ) => {
		expect( getDurationColor( ms ) ).toBe( color );
		expect( getDurationClass( ms ) ).toBe( klass );
	} );
} );

describe( 'formatDuration', () => {
	it.each( [
		[ null, '-' ],
		[ undefined, '-' ],
		[ 0.05, '50us' ],
		[ 0.5, '0.50ms' ],
		[ 50, '50.0ms' ],
		[ 999.9, '999.9ms' ],
		[ 1500, '1.50s' ],
		[ 60000, '60.00s' ],
	] )( '%s -> %s', ( input, expected ) => {
		expect( formatDuration( input ) ).toBe( expected );
	} );
} );

describe( 'getStateColor', () => {
	const originalCategories = window.eventLoggerHookCategories;
	const originalColors = window.eventLoggerCustomColors;

	beforeEach( () => {
		jest.resetModules();
		delete window.eventLoggerHookCategories;
		delete window.eventLoggerCustomColors;
	} );

	afterAll( () => {
		window.eventLoggerHookCategories = originalCategories;
		window.eventLoggerCustomColors = originalColors;
	} );

	it( 'returns the default color when name is empty', () => {
		expect( getStateColor( '' ) ).toBe( '#9e9e9e' );
		expect( getStateColor( null ) ).toBe( '#9e9e9e' );
	} );

	it( 'returns SYSTEM_COLORS entry for known event names', async () => {
		// Re-import so module-private caches are fresh.
		const { getStateColor: fresh } = await import( '../formatUtils' );
		expect( fresh( 'process' ) ).toBe( '#FF7043' );
		expect( fresh( 'hook' ) ).toBe( '#66BB6A' );
		expect( fresh( 'complete' ) ).toBe( '#4CAF50' );
	} );

	it( 'strips " (start)"/" (complete)" suffixes before lookup', async () => {
		const { getStateColor: fresh } = await import( '../formatUtils' );
		expect( fresh( 'process (start)' ) ).toBe( '#FF7043' );
		expect( fresh( 'process (complete)' ) ).toBe( '#FF7043' );
	} );

	it( 'strips "base: label" to base before lookup', async () => {
		const { getStateColor: fresh } = await import( '../formatUtils' );
		expect( fresh( 'process: doing things' ) ).toBe( '#FF7043' );
	} );

	it( 'falls back to SYSTEM_COLORS.hook for unmatched hook names', async () => {
		const { getStateColor: fresh } = await import( '../formatUtils' );
		expect( fresh( 'unknown_hook_xyz hook' ) ).toBe( '#66BB6A' );
	} );

	it( 'falls back to plugin color for " plugin" suffix', async () => {
		const { getStateColor: fresh } = await import( '../formatUtils' );
		expect( fresh( 'somePlugin plugin' ) ).toBe( '#AB47BC' );
	} );

	it( 'returns custom event color from window.eventLoggerCustomColors', async () => {
		window.eventLoggerCustomColors = { my_event: '#abcdef' };
		const { getStateColor: fresh } = await import( '../formatUtils' );
		expect( fresh( 'my_event' ) ).toBe( '#abcdef' );
	} );

	it( 'returns SYSTEM_COLORS.default for unknown bare names', async () => {
		const { getStateColor: fresh } = await import( '../formatUtils' );
		expect( fresh( 'totally_unknown' ) ).toBe( '#9e9e9e' );
	} );

	it( 'matches hook against compiled patterns from window.eventLoggerHookCategories', async () => {
		window.eventLoggerHookCategories = {
			_patterns: { db: [ '^wp_db_' ] },
			_colors: { db: '#123456' },
		};
		const { getStateColor: fresh } = await import( '../formatUtils' );
		expect( fresh( 'wp_db_query hook' ) ).toBe( '#123456' );
	} );

	it( 'skips invalid regex patterns without throwing', async () => {
		window.eventLoggerHookCategories = {
			_patterns: { bad: [ '(unclosed' ], ok: [ '^good_' ] },
			_colors: { bad: '#deadbe', ok: '#abcdef' },
		};
		const { getStateColor: fresh } = await import( '../formatUtils' );
		// Bad pattern is silently dropped; the good one still wins.
		expect( fresh( 'good_hook hook' ) ).toBe( '#abcdef' );
	} );

	it( 'caches lookups so repeat calls do not rescan', async () => {
		window.eventLoggerHookCategories = {
			_patterns: { net: [ '^http_' ] },
			_colors: { net: '#001122' },
		};
		const { getStateColor: fresh } = await import( '../formatUtils' );
		expect( fresh( 'http_call hook' ) ).toBe( '#001122' );
		// Mutating window after the cache is built doesn't change cached results.
		window.eventLoggerHookCategories._colors.net = '#999999';
		expect( fresh( 'http_call hook' ) ).toBe( '#001122' );
	} );

	it( 'handles missing _patterns/_colors gracefully', async () => {
		window.eventLoggerHookCategories = {}; // No _patterns/_colors.
		const { getStateColor: fresh } = await import( '../formatUtils' );
		expect( fresh( 'something hook' ) ).toBe( '#66BB6A' );
	} );
} );
