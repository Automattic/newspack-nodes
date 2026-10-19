/**
 * LayoutContext — where the canvas is looking, and where nodes sit.
 *
 * `positionOverrides` / `onPositionChange` / `viewport` / `onViewportChange`
 * ride context rather than TopologyConsole → ConsoleShell → GraphView →
 * SchematicCanvas props, because GraphView would only forward all four and
 * read none.
 *
 * Layout is per-cwd (`scopeFromCwd` keys the storage), so a draft gets its own
 * layout scope for free.
 */

import { renderHook } from '@testing-library/react';
import { LayoutProvider, useLayoutContext } from '../LayoutContext';

describe( 'useLayoutContext', () => {
	it( 'carries positions and viewport to a consumer', () => {
		const value = {
			positionOverrides: { 'quokka-tee': { x: 42, y: 99 } },
			onPositionChange: () => {},
			viewport: { x: 1, y: 2, w: 3, h: 4 },
			onViewportChange: () => {},
		};
		const wrapper = ( { children } ) => (
			<LayoutProvider { ...value }>{ children }</LayoutProvider>
		);

		const { result } = renderHook( () => useLayoutContext(), { wrapper } );

		expect( result.current ).toEqual( value );
	} );

	it( 'keeps a null viewport null — uncontrolled is not "no viewport"', () => {
		// SchematicCanvas branches on null to mean "I own my own viewport".
		// Defaulting it to an object would silently take that away.
		const wrapper = ( { children } ) => (
			<LayoutProvider>{ children }</LayoutProvider>
		);

		const { result } = renderHook( () => useLayoutContext(), { wrapper } );

		expect( result.current.viewport ).toBeNull();
		expect( result.current.positionOverrides ).toEqual( {} );
	} );

	it( 'keeps one value identity when a provider omits everything', () => {
		const wrapper = ( { children } ) => (
			<LayoutProvider>{ children }</LayoutProvider>
		);
		const { result, rerender } = renderHook( () => useLayoutContext(), {
			wrapper,
		} );
		const first = result.current;

		rerender();

		expect( result.current ).toBe( first );
	} );

	it( 'throws outside a provider rather than serving an empty layout', () => {
		const quiet = jest
			.spyOn( console, 'error' )
			.mockImplementation( () => {} );
		try {
			expect( () => renderHook( () => useLayoutContext() ) ).toThrow(
				/LayoutProvider/
			);
		} finally {
			quiet.mockRestore();
		}
	} );
} );
