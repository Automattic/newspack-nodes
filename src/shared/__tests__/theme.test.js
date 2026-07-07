import {
	THEME_STORAGE_KEY,
	DEFAULT_THEME,
	THEMES,
	isValidTheme,
	getStoredTheme,
	applySkin,
	initSkin,
	resetSkin,
	SKIN_EVENT,
} from '../theme';

const root = () => document.documentElement;

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

describe( 'applySkin / initSkin / resetSkin (the global <html> skin)', () => {
	afterEach( () => {
		resetSkin();
		window.localStorage.clear();
	} );

	it( 'applySkin sets the theme-<slug> class on <html> and persists it', () => {
		applySkin( 'crt' );
		expect( root().classList.contains( 'theme-crt' ) ).toBe( true );
		expect( window.localStorage.getItem( THEME_STORAGE_KEY ) ).toBe(
			'crt'
		);
	} );

	it( 'applySkin replaces the prior theme class (only one at a time)', () => {
		applySkin( 'crt' );
		applySkin( 'blueprint' );
		expect( root().classList.contains( 'theme-crt' ) ).toBe( false );
		expect( root().classList.contains( 'theme-blueprint' ) ).toBe( true );
	} );

	it( 'applySkin coerces an unknown slug to the default', () => {
		applySkin( 'bogus' );
		expect( root().classList.contains( `theme-${ DEFAULT_THEME }` ) ).toBe(
			true
		);
		expect( window.localStorage.getItem( THEME_STORAGE_KEY ) ).toBe(
			DEFAULT_THEME
		);
	} );

	it( 'applySkin dispatches the SKIN_EVENT with the applied slug', () => {
		const seen = [];
		const onSkin = ( e ) => seen.push( e.detail );
		window.addEventListener( SKIN_EVENT, onSkin );
		try {
			applySkin( 'nord' );
		} finally {
			window.removeEventListener( SKIN_EVENT, onSkin );
		}
		expect( seen ).toEqual( [ 'nord' ] );
	} );

	it( 'applySkin still applies the class when localStorage.setItem throws', () => {
		const setItem = window.Storage.prototype.setItem;
		window.Storage.prototype.setItem = () => {
			throw new Error( 'denied' );
		};
		try {
			expect( () => applySkin( 'crt' ) ).not.toThrow();
			expect( root().classList.contains( 'theme-crt' ) ).toBe( true );
		} finally {
			window.Storage.prototype.setItem = setItem;
		}
	} );

	it( 'initSkin applies the PERSISTED skin class WITHOUT re-persisting', () => {
		window.localStorage.setItem( THEME_STORAGE_KEY, 'blueprint' );
		initSkin();
		expect( root().classList.contains( 'theme-blueprint' ) ).toBe( true );
	} );

	it( 'initSkin on an empty preference applies the default but leaves storage empty', () => {
		initSkin();
		expect( root().classList.contains( `theme-${ DEFAULT_THEME }` ) ).toBe(
			true
		);
		expect( window.localStorage.getItem( THEME_STORAGE_KEY ) ).toBeNull();
	} );

	it( 'resetSkin strips the theme class off <html>', () => {
		applySkin( 'crt' );
		resetSkin();
		expect(
			[ ...root().classList ].some( ( c ) => c.startsWith( 'theme-' ) )
		).toBe( false );
	} );
} );
