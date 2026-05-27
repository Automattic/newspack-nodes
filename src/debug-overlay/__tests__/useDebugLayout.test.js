import { renderHook, act } from '@testing-library/react';
import { useDebugLayout } from '../useDebugLayout';

const KEY = 'newspack-nodes:debug:test';

describe( 'useDebugLayout', () => {
	beforeEach( () => {
		window.localStorage.clear();
		jest.useFakeTimers();
	} );
	afterEach( () => jest.useRealTimers() );

	it( 'returns empty defaults on first mount', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		expect( result.current.positions ).toEqual( {} );
		expect( result.current.viewport ).toBeNull();
	} );

	it( 'onPositionChange stores the position and persists it', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onPositionChange( 'a', { x: 100, y: 200 } ) );
		expect( result.current.positions ).toEqual( {
			a: { x: 100, y: 200 },
		} );
		expect(
			JSON.parse( window.localStorage.getItem( `${ KEY }:positions` ) )
		).toEqual( { a: { x: 100, y: 200 } } );
	} );

	it( 'onViewportChange debounces the write to localStorage by 200ms', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onViewportChange( { x: 1, y: 2, k: 1 } ) );
		// State updates immediately; localStorage waits 200ms.
		expect( result.current.viewport ).toEqual( { x: 1, y: 2, k: 1 } );
		expect( window.localStorage.getItem( `${ KEY }:viewport` ) ).toBeNull();
		act( () => jest.advanceTimersByTime( 200 ) );
		expect(
			JSON.parse( window.localStorage.getItem( `${ KEY }:viewport` ) )
		).toEqual( { x: 1, y: 2, k: 1 } );
	} );

	it( 'rehydrates persisted state on mount', () => {
		window.localStorage.setItem(
			`${ KEY }:positions`,
			JSON.stringify( { z: { x: 9, y: 9 } } )
		);
		window.localStorage.setItem(
			`${ KEY }:viewport`,
			JSON.stringify( { x: 0, y: 0, k: 2 } )
		);
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		expect( result.current.positions ).toEqual( {
			z: { x: 9, y: 9 },
		} );
		expect( result.current.viewport ).toEqual( { x: 0, y: 0, k: 2 } );
	} );
} );
