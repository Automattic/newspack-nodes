/**
 * themes — the skin registry consumed by Header (picker options) and
 * TopologyConsole (default + validation of a stored slug).
 */

import { THEMES, DEFAULT_THEME, isValidTheme } from '../themes';

describe( 'themes', () => {
	it( 'exposes 13 skins including the default', () => {
		expect( THEMES ).toHaveLength( 13 );
		expect( THEMES.map( ( t ) => t.slug ) ).toContain( DEFAULT_THEME );
	} );

	it( 'every skin has a non-empty slug and label', () => {
		for ( const t of THEMES ) {
			expect( typeof t.slug ).toBe( 'string' );
			expect( t.slug.length ).toBeGreaterThan( 0 );
			expect( typeof t.label ).toBe( 'string' );
			expect( t.label.length ).toBeGreaterThan( 0 );
		}
	} );

	it( 'has unique slugs', () => {
		const slugs = THEMES.map( ( t ) => t.slug );
		expect( new Set( slugs ).size ).toBe( slugs.length );
	} );

	it( 'DEFAULT_THEME is current', () => {
		expect( DEFAULT_THEME ).toBe( 'current' );
	} );

	it( 'validates known slugs and rejects unknown/empty/undefined', () => {
		expect( isValidTheme( 'blueprint' ) ).toBe( true );
		expect( isValidTheme( 'current' ) ).toBe( true );
		expect( isValidTheme( 'nonsense' ) ).toBe( false );
		expect( isValidTheme( '' ) ).toBe( false );
		expect( isValidTheme( undefined ) ).toBe( false );
		expect( isValidTheme( null ) ).toBe( false );
	} );
} );
