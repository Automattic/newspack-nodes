import { renderHook, act } from '@testing-library/react';
import { usePanelChrome } from '../usePanelChrome';
import {
	DEFAULT_THEME,
	THEME_STORAGE_KEY,
	PALETTE_COLLAPSED_STORAGE_KEY_LIVE,
	PALETTE_COLLAPSED_STORAGE_KEY_EDIT,
} from '../../themes';

const LIVE = PALETTE_COLLAPSED_STORAGE_KEY_LIVE;
const EDIT = PALETTE_COLLAPSED_STORAGE_KEY_EDIT;

function render( props ) {
	return renderHook( ( p ) => usePanelChrome( p ), {
		initialProps: { paletteKey: LIVE, ...props },
	} );
}

describe( 'usePanelChrome', () => {
	beforeEach( () => window.localStorage.clear() );

	describe( 'theme', () => {
		it( 'defaults to DEFAULT_THEME when storage is empty', () => {
			const { result } = render();
			expect( result.current.theme ).toBe( DEFAULT_THEME );
		} );

		it( 'defaults from a valid persisted theme', () => {
			window.localStorage.setItem( THEME_STORAGE_KEY, 'blueprint' );
			const { result } = render();
			expect( result.current.theme ).toBe( 'blueprint' );
		} );

		it( 'falls back to default for an unknown persisted theme', () => {
			window.localStorage.setItem( THEME_STORAGE_KEY, 'not-a-theme' );
			const { result } = render();
			expect( result.current.theme ).toBe( DEFAULT_THEME );
		} );

		it( 'onThemeChange validates + persists a known theme', () => {
			const { result } = render();
			act( () => result.current.onThemeChange( 'crt' ) );
			expect( result.current.theme ).toBe( 'crt' );
			expect( window.localStorage.getItem( THEME_STORAGE_KEY ) ).toBe(
				'crt'
			);
		} );

		it( 'onThemeChange coerces an invalid slug to default', () => {
			window.localStorage.setItem( THEME_STORAGE_KEY, 'crt' );
			const { result } = render();
			act( () => result.current.onThemeChange( 'bogus' ) );
			expect( result.current.theme ).toBe( DEFAULT_THEME );
			expect( window.localStorage.getItem( THEME_STORAGE_KEY ) ).toBe(
				DEFAULT_THEME
			);
		} );

		it( 'onThemeChange crossfades through a View Transition when supported', () => {
			const startViewTransition = jest.fn( ( cb ) => {
				cb();
				return { finished: Promise.resolve() };
			} );
			document.startViewTransition = startViewTransition;
			try {
				const { result } = render();
				act( () => result.current.onThemeChange( 'crt' ) );
				expect( startViewTransition ).toHaveBeenCalledTimes( 1 );
				expect( result.current.theme ).toBe( 'crt' );
			} finally {
				delete document.startViewTransition;
			}
		} );
	} );

	describe( 'palette-collapsed', () => {
		it( 'defaults collapsed (overlay live default)', () => {
			const { result } = render();
			expect( result.current.paletteCollapsed ).toBe( true );
		} );

		it( 'honors defaultCollapsed=false (edit default)', () => {
			const { result } = render( {
				paletteKey: EDIT,
				defaultCollapsed: false,
			} );
			expect( result.current.paletteCollapsed ).toBe( false );
		} );

		it( "reads stored '0' as open regardless of default", () => {
			window.localStorage.setItem( LIVE, '0' );
			const { result } = render();
			expect( result.current.paletteCollapsed ).toBe( false );
		} );

		it( "reads stored '1' as collapsed regardless of default", () => {
			window.localStorage.setItem( EDIT, '1' );
			const { result } = render( {
				paletteKey: EDIT,
				defaultCollapsed: false,
			} );
			expect( result.current.paletteCollapsed ).toBe( true );
		} );

		it( 'togglePaletteCollapsed flips + persists to the active key', () => {
			const { result } = render();
			act( () => result.current.togglePaletteCollapsed() );
			expect( result.current.paletteCollapsed ).toBe( false );
			expect( window.localStorage.getItem( LIVE ) ).toBe( '0' );
			act( () => result.current.togglePaletteCollapsed() );
			expect( result.current.paletteCollapsed ).toBe( true );
			expect( window.localStorage.getItem( LIVE ) ).toBe( '1' );
		} );

		it( 'reloads palette state when paletteKey changes (console mode switch)', () => {
			window.localStorage.setItem( EDIT, '0' );
			const { result, rerender } = render();
			expect( result.current.paletteCollapsed ).toBe( true );
			rerender( { paletteKey: EDIT, defaultCollapsed: false } );
			expect( result.current.paletteCollapsed ).toBe( false );
		} );
	} );

	describe( 'throwing localStorage', () => {
		let getItem;
		let setItem;
		beforeEach( () => {
			getItem = window.Storage.prototype.getItem;
			setItem = window.Storage.prototype.setItem;
			window.Storage.prototype.getItem = () => {
				throw new Error( 'denied' );
			};
			window.Storage.prototype.setItem = () => {
				throw new Error( 'denied' );
			};
		} );
		afterEach( () => {
			window.Storage.prototype.getItem = getItem;
			window.Storage.prototype.setItem = setItem;
		} );

		it( 'falls back to defaults on a throwing getItem', () => {
			const { result } = render();
			expect( result.current.theme ).toBe( DEFAULT_THEME );
			expect( result.current.paletteCollapsed ).toBe( true );
		} );

		it( 'swallows a throwing setItem in onThemeChange + toggle', () => {
			const { result } = render();
			expect( () =>
				act( () => result.current.onThemeChange( 'crt' ) )
			).not.toThrow();
			expect( result.current.theme ).toBe( 'crt' );
			expect( () =>
				act( () => result.current.togglePaletteCollapsed() )
			).not.toThrow();
			expect( result.current.paletteCollapsed ).toBe( false );
		} );
	} );
} );
