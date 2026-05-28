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

	it( 'falls back to empty/null when stored JSON is malformed', () => {
		window.localStorage.setItem( `${ KEY }:positions`, '{not valid json' );
		window.localStorage.setItem( `${ KEY }:viewport`, '{also invalid' );
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		expect( result.current.positions ).toEqual( {} );
		expect( result.current.viewport ).toBeNull();
	} );

	it( 'resetLayout clears positions, viewport, and the persisted keys', () => {
		window.localStorage.setItem(
			`${ KEY }:positions`,
			JSON.stringify( { a: { x: 1, y: 1 } } )
		);
		window.localStorage.setItem(
			`${ KEY }:viewport`,
			JSON.stringify( { x: 5, y: 5, k: 1 } )
		);
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		expect( result.current.positions ).not.toEqual( {} );
		act( () => result.current.resetLayout() );
		expect( result.current.positions ).toEqual( {} );
		expect( result.current.viewport ).toBeNull();
		expect(
			window.localStorage.getItem( `${ KEY }:positions` )
		).toBeNull();
		expect( window.localStorage.getItem( `${ KEY }:viewport` ) ).toBeNull();
	} );

	it( 'onViewportChange(null) removes the persisted viewport key after debounce', () => {
		window.localStorage.setItem(
			`${ KEY }:viewport`,
			JSON.stringify( { x: 1, y: 2, k: 1 } )
		);
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onViewportChange( null ) );
		expect( result.current.viewport ).toBeNull();
		// removeItem fires after the 200ms debounce.
		act( () => jest.advanceTimersByTime( 200 ) );
		expect( window.localStorage.getItem( `${ KEY }:viewport` ) ).toBeNull();
	} );

	it( 'rapid onViewportChange calls only persist the final value (debounce cancels prior)', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onViewportChange( { x: 1, y: 1, k: 1 } ) );
		act( () => jest.advanceTimersByTime( 100 ) );
		act( () => result.current.onViewportChange( { x: 2, y: 2, k: 2 } ) );
		// Earlier timer should be cancelled — advancing 200ms from the SECOND
		// call lands the final value, not the first.
		act( () => jest.advanceTimersByTime( 200 ) );
		expect(
			JSON.parse( window.localStorage.getItem( `${ KEY }:viewport` ) )
		).toEqual( { x: 2, y: 2, k: 2 } );
	} );

	it( 'unmount cancels a pending viewport debounce', () => {
		const { result, unmount } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onViewportChange( { x: 7, y: 7, k: 1 } ) );
		unmount();
		act( () => jest.advanceTimersByTime( 500 ) );
		// Unmount cleaned up the timer before it could persist.
		expect( window.localStorage.getItem( `${ KEY }:viewport` ) ).toBeNull();
	} );

	it( 'reloads positions + viewport when storageKey changes (cwd switch)', () => {
		window.localStorage.setItem(
			'newspack-nodes:debug:scopeA:positions',
			JSON.stringify( { fromA: { x: 1, y: 1 } } )
		);
		window.localStorage.setItem(
			'newspack-nodes:debug:scopeB:positions',
			JSON.stringify( { fromB: { x: 2, y: 2 } } )
		);
		const { result, rerender } = renderHook(
			( { key } ) => useDebugLayout( key ),
			{ initialProps: { key: 'newspack-nodes:debug:scopeA' } }
		);
		expect( result.current.positions ).toEqual( {
			fromA: { x: 1, y: 1 },
		} );
		rerender( { key: 'newspack-nodes:debug:scopeB' } );
		expect( result.current.positions ).toEqual( {
			fromB: { x: 2, y: 2 },
		} );
	} );

	it( 'a pending debounce is cancelled on storageKey change, not written to the old scope', () => {
		const { result, rerender } = renderHook(
			( { key } ) => useDebugLayout( key ),
			{ initialProps: { key: 'newspack-nodes:debug:scopeA' } }
		);
		act( () => result.current.onViewportChange( { x: 9, y: 9, k: 1 } ) );
		// Switch scope before the debounce fires.
		rerender( { key: 'newspack-nodes:debug:scopeB' } );
		act( () => jest.advanceTimersByTime( 500 ) );
		expect(
			window.localStorage.getItem(
				'newspack-nodes:debug:scopeA:viewport'
			)
		).toBeNull();
		expect(
			window.localStorage.getItem(
				'newspack-nodes:debug:scopeB:viewport'
			)
		).toBeNull();
	} );

	it( 'survives localStorage.setItem throwing (in-session only)', () => {
		const original = window.localStorage.setItem;
		window.localStorage.setItem = jest.fn( () => {
			throw new Error( 'quota exceeded' );
		} );
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		expect( () =>
			act( () => result.current.onPositionChange( 'a', { x: 1, y: 2 } ) )
		).not.toThrow();
		expect( result.current.positions ).toEqual( {
			a: { x: 1, y: 2 },
		} );
		act( () => result.current.onViewportChange( { x: 1, y: 1, k: 1 } ) );
		expect( () =>
			act( () => jest.advanceTimersByTime( 200 ) )
		).not.toThrow();
		expect( () => act( () => result.current.resetLayout() ) ).not.toThrow();
		window.localStorage.setItem = original;
	} );
} );
