import { renderHook, act } from '@testing-library/react';
import { usePanelChrome } from '../usePanelChrome';
import {
	PALETTE_COLLAPSED_STORAGE_KEY_LIVE,
	PALETTE_COLLAPSED_STORAGE_KEY_EDIT,
	INSPECTOR_COLLAPSED_STORAGE_KEY,
} from '../../themes';

const LIVE = PALETTE_COLLAPSED_STORAGE_KEY_LIVE;
const EDIT = PALETTE_COLLAPSED_STORAGE_KEY_EDIT;
const INSPECTOR = INSPECTOR_COLLAPSED_STORAGE_KEY;

function render( props ) {
	return renderHook( ( p ) => usePanelChrome( p ), {
		initialProps: { paletteKey: LIVE, ...props },
	} );
}

// The skin is NOT owned here — it's the global `<html>.theme-<slug>` class (see
// shared/theme.js `applySkin`). This hook is only the palette + inspector chrome.
describe( 'usePanelChrome', () => {
	beforeEach( () => window.localStorage.clear() );

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

	describe( 'inspector', () => {
		it( 'defaults to collapsed (a rail until a selection or the toggle opens it)', () => {
			const { result } = render();
			expect( result.current.inspectorCollapsed ).toBe( true );
		} );

		it( "reads stored '0' as expanded", () => {
			window.localStorage.setItem( INSPECTOR, '0' );
			const { result } = render();
			expect( result.current.inspectorCollapsed ).toBe( false );
		} );

		it( 'toggleInspectorCollapsed flips + persists', () => {
			const { result } = render();
			act( () => result.current.toggleInspectorCollapsed() );
			expect( result.current.inspectorCollapsed ).toBe( false );
			expect( window.localStorage.getItem( INSPECTOR ) ).toBe( '0' );
			act( () => result.current.toggleInspectorCollapsed() );
			expect( result.current.inspectorCollapsed ).toBe( true );
			expect( window.localStorage.getItem( INSPECTOR ) ).toBe( '1' );
		} );

		it( 'setInspectorCollapsed(false) opens it (for auto-expand on select)', () => {
			window.localStorage.setItem( INSPECTOR, '1' );
			const { result } = render();
			expect( result.current.inspectorCollapsed ).toBe( true );
			act( () => result.current.setInspectorCollapsed( false ) );
			expect( result.current.inspectorCollapsed ).toBe( false );
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
			expect( result.current.paletteCollapsed ).toBe( true );
		} );

		it( 'swallows a throwing setItem in the palette toggle', () => {
			const { result } = render();
			expect( () =>
				act( () => result.current.togglePaletteCollapsed() )
			).not.toThrow();
			expect( result.current.paletteCollapsed ).toBe( false );
		} );
	} );
} );
