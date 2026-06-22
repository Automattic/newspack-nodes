import {
	THEMES,
	DEFAULT_THEME,
	isValidTheme,
	getStoredTheme,
	THEME_STORAGE_KEY,
} from '../themes';

describe( 'Newspack skins', () => {
	it( 'defaults to newspack', () => {
		expect( DEFAULT_THEME ).toBe( 'newspack' );
	} );

	it( 'registers both Newspack skins as the first two entries', () => {
		expect( THEMES[ 0 ] ).toMatchObject( { slug: 'newspack' } );
		expect( THEMES[ 1 ] ).toMatchObject( { slug: 'newspack-brand' } );
	} );

	it( 'treats both Newspack slugs as valid', () => {
		expect( isValidTheme( 'newspack' ) ).toBe( true );
		expect( isValidTheme( 'newspack-brand' ) ).toBe( true );
	} );

	it( 'keeps CRT registered (leave-it-alone guard)', () => {
		expect( THEMES.map( ( t ) => t.slug ) ).toContain( 'crt' );
	} );

	it( 'has unique, non-empty slugs', () => {
		const slugs = THEMES.map( ( t ) => t.slug );
		expect( new Set( slugs ).size ).toBe( slugs.length );
		slugs.forEach( ( s ) => expect( s ).toMatch( /\S/ ) );
	} );

	it( 'every skin has a non-empty label', () => {
		THEMES.forEach( ( t ) => expect( t.label ).toMatch( /\S/ ) );
	} );

	it( 'rejects unknown, empty, and non-string slugs', () => {
		[ 'nonsense', '', undefined, null ].forEach( ( s ) =>
			expect( isValidTheme( s ) ).toBe( false )
		);
	} );
} );

describe( 'getStoredTheme', () => {
	afterEach( () => window.localStorage.clear() );

	it( 'returns the persisted slug when valid', () => {
		window.localStorage.setItem( THEME_STORAGE_KEY, 'crt' );
		expect( getStoredTheme() ).toBe( 'crt' );
	} );

	it( 'falls back to the default for an absent or unknown slug', () => {
		expect( getStoredTheme() ).toBe( DEFAULT_THEME );
		window.localStorage.setItem( THEME_STORAGE_KEY, 'bogus' );
		expect( getStoredTheme() ).toBe( DEFAULT_THEME );
	} );
} );
