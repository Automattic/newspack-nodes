/**
 * Tests for useNarrow — true while the viewport is under NARROW_PX, read
 * through one module-level media query and followed across its changes.
 */

import { renderHook, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import useNarrow, { NARROW_PX, resetNarrow } from '../useNarrow';
import { installViewport } from '../../test-utils/viewportWidth';

describe( 'useNarrow', () => {
	let viewport;
	afterEach( () => viewport?.restore() );

	it( 'puts the breakpoint at 600 px', () => {
		expect( NARROW_PX ).toBe( 600 );
	} );

	it( 'asks for a viewport narrower than the breakpoint', () => {
		viewport = installViewport( true );
		renderHook( () => useNarrow() );
		expect( viewport.queries ).toEqual( [ '(width < 600px)' ] );
	} );

	it( 'reads narrow on the first render, so a narrow page never flashes tabs', () => {
		viewport = installViewport( true );
		const seen = [];
		renderHook( () => seen.push( useNarrow() ) );
		expect( seen[ 0 ] ).toBe( true );
	} );

	it( 'follows the query when the viewport crosses the breakpoint', () => {
		viewport = installViewport( false );
		const { result } = renderHook( () => useNarrow() );
		expect( result.current ).toBe( false );

		act( () => viewport.setNarrow( true ) );
		expect( result.current ).toBe( true );

		act( () => viewport.setNarrow( false ) );
		expect( result.current ).toBe( false );
	} );

	it( 'serves every reader from one list and one listener', () => {
		viewport = installViewport( true );
		const first = renderHook( () => useNarrow() );
		const second = renderHook( () => useNarrow() );
		expect( viewport.lists ).toBe( 1 );
		expect( viewport.listeners.size ).toBe( 1 );

		act( () => viewport.setNarrow( false ) );
		expect( first.result.current ).toBe( false );
		expect( second.result.current ).toBe( false );
	} );

	it( 'stops listening when the last reader unmounts', () => {
		viewport = installViewport( true );
		const first = renderHook( () => useNarrow() );
		const second = renderHook( () => useNarrow() );
		first.unmount();
		expect( viewport.listeners.size ).toBe( 1 );
		second.unmount();
		expect( viewport.listeners.size ).toBe( 0 );
	} );

	it( 'keeps the list it built until a test resets it', () => {
		viewport = installViewport( true );
		renderHook( () => useNarrow() ).unmount();

		const asked = [];
		window.matchMedia = ( query ) => {
			asked.push( query );
			return {
				matches: false,
				addEventListener: () => {},
				removeEventListener: () => {},
			};
		};
		expect( renderHook( () => useNarrow() ).result.current ).toBe( true );
		expect( asked ).toEqual( [] );

		resetNarrow();
		expect( renderHook( () => useNarrow() ).result.current ).toBe( false );
		expect( asked ).toEqual( [ '(width < 600px)' ] );
	} );

	it( 'answers wide where the window has no matchMedia', () => {
		const original = window.matchMedia;
		delete window.matchMedia;
		resetNarrow();
		try {
			const { result } = renderHook( () => useNarrow() );
			expect( result.current ).toBe( false );
		} finally {
			window.matchMedia = original;
		}
	} );

	it( 'renders wide on the server, whatever the browser would answer', () => {
		viewport = installViewport( true );
		const Probe = () => ( useNarrow() ? 'narrow' : 'wide' );
		expect( renderToString( <Probe /> ) ).toBe( 'wide' );
	} );
} );
