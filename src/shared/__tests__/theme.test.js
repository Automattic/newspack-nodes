import {
	THEME_STORAGE_KEY,
	DEFAULT_THEME,
	THEMES,
	isValidTheme,
	getStoredTheme,
	setTheme,
	subscribeTheme,
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

describe( 'reactive theme store', () => {
	afterEach( () => window.localStorage.clear() );

	it( 'setTheme persists the slug so getStoredTheme reads it back', () => {
		setTheme( 'crt' );
		expect( getStoredTheme() ).toBe( 'crt' );
	} );

	it( 'setTheme coerces an invalid slug to the default', () => {
		setTheme( 'bogus' );
		expect( getStoredTheme() ).toBe( DEFAULT_THEME );
	} );

	it( 'notifies subscribers on change and stops after unsubscribe', () => {
		const seen = [];
		const unsubscribe = subscribeTheme( () =>
			seen.push( getStoredTheme() )
		);
		setTheme( 'nord' );
		expect( seen ).toEqual( [ 'nord' ] );
		unsubscribe();
		setTheme( 'crt' );
		expect( seen ).toEqual( [ 'nord' ] );
	} );
} );
