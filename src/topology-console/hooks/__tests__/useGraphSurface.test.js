/**
 * useGraphSurface — the shared chrome the topology console AND the debug overlay
 * both hand to ConsoleShell, so the inspector + transcript-overlay + palette
 * wiring lives in ONE place (previously each consumer assembled its own copy and
 * the overlay kept missing features). Wraps usePanelChrome and adds the
 * transcript-overlay + repl-expand state, exposing ready-to-spread
 * the replChromeProps fragment.
 */

import { renderHook, act } from '@testing-library/react';
import { useGraphSurface } from '../useGraphSurface';
import { PALETTE_COLLAPSED_STORAGE_KEY_LIVE } from '../../themes';

beforeEach( () => window.localStorage.clear() );

const render = ( props = {} ) =>
	renderHook( ( p ) => useGraphSurface( p ), {
		initialProps: {
			paletteKey: PALETTE_COLLAPSED_STORAGE_KEY_LIVE,
			...props,
		},
	} );

describe( 'useGraphSurface', () => {
	it( 'replChromeProps carries the expand + overlay-height wiring', () => {
		const { result } = render();
		const rp = result.current.replChromeProps;
		expect( rp.expanded ).toBe( false );
		expect( typeof rp.onExpandedChange ).toBe( 'function' );
		expect( rp.inputRef ).toBeDefined();
		expect( typeof rp.onOverlayHeightChange ).toBe( 'function' );
	} );

	it( 'openInspectorOnSelect expands on a node id and no-ops on deselect (null)', () => {
		const { result } = render();
		expect( result.current.inspectorCollapsed ).toBe( true );
		act( () => result.current.openInspectorOnSelect( 'n1' ) );
		expect( result.current.inspectorCollapsed ).toBe( false );
		act( () => result.current.openInspectorOnSelect( null ) );
		expect( result.current.inspectorCollapsed ).toBe( false );
	} );

	it( 'a reported transcript overlay height flows into bottomObstructionPx', () => {
		const { result } = render();
		act( () =>
			result.current.replChromeProps.onOverlayHeightChange( 120 )
		);
		expect( result.current.transcriptOverlayPx ).toBe( 120 );
	} );
} );
