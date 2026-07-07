import {
	THEME_STORAGE_KEY,
	DEFAULT_THEME,
	THEMES,
	isValidTheme,
	getStoredTheme,
} from '../theme';

describe( 'shared theme storage helpers', () => {
	afterEach( () => window.localStorage.clear() );

	it( 'defaults to newspack', () => {
		expect( DEFAULT_THEME ).toBe( 'newspack' );
	} );

	it( 'exposes a non-empty THEMES catalog whose default slug is registered', () => {
		expect( Array.isArray( THEMES ) ).toBe( true );
		expect( THEMES.length ).toBeGreaterThan( 0 );
		expect( THEMES.map( ( t ) => t.slug ) ).toContain( DEFAULT_THEME );
	} );

	it( 'validates registered slugs and rejects unknown/empty/non-string', () => {
		expect( isValidTheme( DEFAULT_THEME ) ).toBe( true );
		[ 'nonsense', '', undefined, null, 42 ].forEach( ( s ) =>
			expect( isValidTheme( s ) ).toBe( false )
		);
	} );

	it( 'getStoredTheme returns the persisted slug when valid', () => {
		window.localStorage.setItem( THEME_STORAGE_KEY, 'crt' );
		expect( getStoredTheme() ).toBe( 'crt' );
	} );

	it( 'getStoredTheme falls back to the default for an absent slug', () => {
		expect( getStoredTheme() ).toBe( DEFAULT_THEME );
	} );

	it( 'getStoredTheme falls back to the default for an unknown slug', () => {
		window.localStorage.setItem( THEME_STORAGE_KEY, 'bogus' );
		expect( getStoredTheme() ).toBe( DEFAULT_THEME );
	} );
} );
