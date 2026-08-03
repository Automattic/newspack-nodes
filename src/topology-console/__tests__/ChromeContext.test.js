/**
 * ChromeContext — the panel chrome the canvas surface reacts to.
 *
 * Only the three GraphView forwards without reading: the palette's collapse
 * state and toggle, which go to `Palette`, and the transcript overlay's height,
 * which `SchematicCanvas` reserves in autofit.
 *
 * `inspectorCollapsed` / `onInspectorToggle` are deliberately NOT here.
 * GraphView renders the inspector's own chevron and reads both five and two
 * times respectively — they are its state, not ambient, and moving them would
 * be lifting a prop away from its only real consumer.
 */

import { renderHook } from '@testing-library/react';
import { ChromeProvider, useChrome } from '../ChromeContext';

describe( 'useChrome', () => {
	it( 'carries the palette state and the obstruction height', () => {
		const onPaletteToggle = () => {};
		const wrapper = ( { children } ) => (
			<ChromeProvider
				paletteCollapsed
				onPaletteToggle={ onPaletteToggle }
				bottomObstructionPx={ 132 }
			>
				{ children }
			</ChromeProvider>
		);

		const { result } = renderHook( () => useChrome(), { wrapper } );

		expect( result.current ).toEqual( {
			paletteCollapsed: true,
			onPaletteToggle,
			bottomObstructionPx: 132,
		} );
	} );

	it( 'defaults the obstruction to zero, not undefined', () => {
		// SchematicCanvas does arithmetic with it; undefined yields NaN and a
		// canvas that autofits to nothing.
		const wrapper = ( { children } ) => (
			<ChromeProvider>{ children }</ChromeProvider>
		);

		const { result } = renderHook( () => useChrome(), { wrapper } );

		expect( result.current.bottomObstructionPx ).toBe( 0 );
		expect( result.current.paletteCollapsed ).toBe( false );
	} );

	it( 'throws outside a provider', () => {
		const quiet = jest
			.spyOn( console, 'error' )
			.mockImplementation( () => {} );
		try {
			expect( () => renderHook( () => useChrome() ) ).toThrow(
				/ChromeProvider/
			);
		} finally {
			quiet.mockRestore();
		}
	} );
} );
