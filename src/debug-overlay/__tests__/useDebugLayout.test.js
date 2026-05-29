/**
 * Per-dashboard layout state for the overlay/console:
 * ONE localStorage entry at `storageKey` → `{ positions, viewport, dirty }`.
 * Empty entry = no layout yet (canvas autoLayouts and calls onSeedLayout to
 * persist the result with dirty=false). Any user modification flips dirty
 * to true; resetLayout clears the entry; "Reset Layout" UI is gated on
 * isDirty. No version field — the shape is fixed.
 */

import { renderHook, act } from '@testing-library/react';
import { useDebugLayout } from '../useDebugLayout';

const KEY = 'newspack-nodes:debug:test';

describe( 'useDebugLayout', () => {
	beforeEach( () => {
		window.localStorage.clear();
		jest.useFakeTimers();
	} );
	afterEach( () => jest.useRealTimers() );

	it( 'returns empty defaults + isDirty=false on first mount', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		expect( result.current.positions ).toEqual( {} );
		expect( result.current.viewport ).toBeNull();
		expect( result.current.isDirty ).toBe( false );
	} );

	it( 'onPositionChange stores the position, sets dirty=true, persists the single key', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onPositionChange( 'a', { x: 100, y: 200 } ) );
		expect( result.current.positions ).toEqual( {
			a: { x: 100, y: 200 },
		} );
		expect( result.current.isDirty ).toBe( true );
		expect( JSON.parse( window.localStorage.getItem( KEY ) ) ).toEqual( {
			positions: { a: { x: 100, y: 200 } },
			viewport: null,
			dirty: true,
		} );
	} );

	it( 'onViewportChange persists viewport without flipping dirty (pan/zoom is not a layout modification)', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onViewportChange( { x: 1, y: 2, k: 1 } ) );
		expect( result.current.viewport ).toEqual( { x: 1, y: 2, k: 1 } );
		expect( result.current.isDirty ).toBe( false );
		expect( window.localStorage.getItem( KEY ) ).toBeNull();
		act( () => jest.advanceTimersByTime( 200 ) );
		expect( JSON.parse( window.localStorage.getItem( KEY ) ) ).toEqual( {
			positions: {},
			viewport: { x: 1, y: 2, k: 1 },
			dirty: false,
		} );
	} );

	it( 'rehydrates positions + viewport + isDirty from a persisted entry', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: { z: { x: 9, y: 9 } },
				viewport: { x: 0, y: 0, k: 2 },
				dirty: true,
			} )
		);
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		expect( result.current.positions ).toEqual( { z: { x: 9, y: 9 } } );
		expect( result.current.viewport ).toEqual( { x: 0, y: 0, k: 2 } );
		expect( result.current.isDirty ).toBe( true );
	} );

	it( 'rehydrated entry with dirty=false stays clean (seeded layout sticks)', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: { z: { x: 9, y: 9 } },
				viewport: null,
				dirty: false,
			} )
		);
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		expect( result.current.isDirty ).toBe( false );
		expect( result.current.positions ).toEqual( { z: { x: 9, y: 9 } } );
	} );

	it( 'falls back to clean defaults when the stored JSON is malformed', () => {
		window.localStorage.setItem( KEY, '{not valid json' );
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		expect( result.current.positions ).toEqual( {} );
		expect( result.current.viewport ).toBeNull();
		expect( result.current.isDirty ).toBe( false );
	} );

	it( 'resetLayout clears state, isDirty, and removes the persisted entry', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: { a: { x: 1, y: 1 } },
				viewport: { x: 5, y: 5, k: 1 },
				dirty: true,
			} )
		);
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		expect( result.current.isDirty ).toBe( true );
		act( () => result.current.resetLayout() );
		expect( result.current.positions ).toEqual( {} );
		expect( result.current.viewport ).toBeNull();
		expect( result.current.isDirty ).toBe( false );
		expect( window.localStorage.getItem( KEY ) ).toBeNull();
	} );

	it( 'onSeedLayout persists positions with dirty=false when state is clean and empty', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () =>
			result.current.onSeedLayout( {
				a: { x: 60, y: 80 },
				b: { x: 300, y: 80 },
			} )
		);
		expect( result.current.positions ).toEqual( {
			a: { x: 60, y: 80 },
			b: { x: 300, y: 80 },
		} );
		expect( result.current.isDirty ).toBe( false );
		expect( JSON.parse( window.localStorage.getItem( KEY ) ) ).toEqual( {
			positions: { a: { x: 60, y: 80 }, b: { x: 300, y: 80 } },
			viewport: null,
			dirty: false,
		} );
	} );

	it( 'onSeedLayout is a no-op when dirty=true (never overwrites user edits)', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onPositionChange( 'a', { x: 1, y: 2 } ) );
		const before = result.current.positions;
		act( () =>
			result.current.onSeedLayout( {
				a: { x: 999, y: 999 },
				b: { x: 999, y: 999 },
			} )
		);
		expect( result.current.positions ).toEqual( before );
		expect( result.current.isDirty ).toBe( true );
	} );

	it( 'onSeedLayout is a no-op when positions is already populated (already seeded)', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: { z: { x: 9, y: 9 } },
				viewport: null,
				dirty: false,
			} )
		);
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onSeedLayout( { a: { x: 60, y: 80 } } ) );
		expect( result.current.positions ).toEqual( { z: { x: 9, y: 9 } } );
		expect( result.current.isDirty ).toBe( false );
	} );

	it( 'renamePosition moves the entry from oldId to newId, preserves dirty', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () =>
			result.current.onSeedLayout( {
				a: { x: 10, y: 20 },
				b: { x: 30, y: 40 },
			} )
		);
		expect( result.current.isDirty ).toBe( false );
		act( () => result.current.renamePosition( 'a', 'a2' ) );
		expect( result.current.positions ).toEqual( {
			a2: { x: 10, y: 20 },
			b: { x: 30, y: 40 },
		} );
		// Rename is dirty-neutral — not a user position change.
		expect( result.current.isDirty ).toBe( false );
		expect(
			JSON.parse( window.localStorage.getItem( KEY ) ).positions
		).toEqual( {
			a2: { x: 10, y: 20 },
			b: { x: 30, y: 40 },
		} );
	} );

	it( 'renamePosition is a no-op when oldId has no entry', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onSeedLayout( { a: { x: 1, y: 1 } } ) );
		const before = result.current.positions;
		act( () => result.current.renamePosition( 'zzz', 'qqq' ) );
		expect( result.current.positions ).toBe( before );
	} );

	it( 'onSeedLayout clears viewport on a successful seed (canvas re-autofits to the seeded nodes)', () => {
		// Reset → reseed flow: after resetLayout clears the entry, the canvas's
		// autofit-on-mount effect commits a viewport based on the intermediate
		// autoLayout positions (pre-seed). When the server seed then lands via
		// onSeedLayout, the viewport must reset to null so the canvas's autofit
		// re-fires with the just-seeded positions; otherwise the bbox is sized
		// for the autoLayout bbox, not the server's.
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		// Simulate the canvas committing an intermediate autofit viewport
		// while positions are still empty.
		act( () =>
			result.current.onViewportChange( { x: 0, y: 0, w: 100, h: 100 } )
		);
		expect( result.current.viewport ).toEqual( {
			x: 0,
			y: 0,
			w: 100,
			h: 100,
		} );
		act( () =>
			result.current.onSeedLayout( {
				a: { x: 60, y: 80 },
				b: { x: 300, y: 80 },
			} )
		);
		expect( result.current.positions ).toEqual( {
			a: { x: 60, y: 80 },
			b: { x: 300, y: 80 },
		} );
		expect( result.current.viewport ).toBeNull();
	} );

	it( 'onSeedLayout ignores an empty positionsMap (nothing to seed)', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onSeedLayout( {} ) );
		expect( result.current.positions ).toEqual( {} );
		expect( window.localStorage.getItem( KEY ) ).toBeNull();
	} );

	it( 'onViewportChange(null) clears the viewport in the persisted entry without flipping dirty', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: { a: { x: 1, y: 1 } },
				viewport: { x: 1, y: 2, k: 1 },
				dirty: true,
			} )
		);
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onViewportChange( null ) );
		expect( result.current.viewport ).toBeNull();
		// Pre-existing dirty (set by a prior drag) is preserved — onViewportChange
		// is dirty-neutral, not a dirty-clear.
		expect( result.current.isDirty ).toBe( true );
		act( () => jest.advanceTimersByTime( 200 ) );
		expect( JSON.parse( window.localStorage.getItem( KEY ) ) ).toEqual( {
			positions: { a: { x: 1, y: 1 } },
			viewport: null,
			dirty: true,
		} );
	} );

	it( 'onViewportChange on a clean (seeded) layout keeps dirty=false', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: { a: { x: 1, y: 1 } },
				viewport: null,
				dirty: false,
			} )
		);
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onViewportChange( { x: 9, y: 9, k: 1 } ) );
		expect( result.current.isDirty ).toBe( false );
		act( () => jest.advanceTimersByTime( 200 ) );
		expect( JSON.parse( window.localStorage.getItem( KEY ) ).dirty ).toBe(
			false
		);
	} );

	it( 'rapid onViewportChange calls debounce — only the final value persists', () => {
		const { result } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onViewportChange( { x: 1, y: 1, k: 1 } ) );
		act( () => jest.advanceTimersByTime( 100 ) );
		act( () => result.current.onViewportChange( { x: 2, y: 2, k: 2 } ) );
		act( () => jest.advanceTimersByTime( 200 ) );
		expect(
			JSON.parse( window.localStorage.getItem( KEY ) ).viewport
		).toEqual( { x: 2, y: 2, k: 2 } );
	} );

	it( 'unmount cancels a pending viewport debounce', () => {
		const { result, unmount } = renderHook( () => useDebugLayout( KEY ) );
		act( () => result.current.onViewportChange( { x: 7, y: 7, k: 1 } ) );
		unmount();
		act( () => jest.advanceTimersByTime( 500 ) );
		expect( window.localStorage.getItem( KEY ) ).toBeNull();
	} );

	it( 'reloads positions + viewport + isDirty when storageKey changes (cwd switch)', () => {
		window.localStorage.setItem(
			'newspack-nodes:debug:scopeA',
			JSON.stringify( {
				positions: { fromA: { x: 1, y: 1 } },
				viewport: null,
				dirty: true,
			} )
		);
		window.localStorage.setItem(
			'newspack-nodes:debug:scopeB',
			JSON.stringify( {
				positions: { fromB: { x: 2, y: 2 } },
				viewport: null,
				dirty: false,
			} )
		);
		const { result, rerender } = renderHook(
			( { key } ) => useDebugLayout( key ),
			{ initialProps: { key: 'newspack-nodes:debug:scopeA' } }
		);
		expect( result.current.positions ).toEqual( {
			fromA: { x: 1, y: 1 },
		} );
		expect( result.current.isDirty ).toBe( true );
		rerender( { key: 'newspack-nodes:debug:scopeB' } );
		expect( result.current.positions ).toEqual( {
			fromB: { x: 2, y: 2 },
		} );
		expect( result.current.isDirty ).toBe( false );
	} );

	it( 'a pending debounce is cancelled on storageKey change (no cross-scope write)', () => {
		const { result, rerender } = renderHook(
			( { key } ) => useDebugLayout( key ),
			{ initialProps: { key: 'newspack-nodes:debug:scopeA' } }
		);
		act( () => result.current.onViewportChange( { x: 9, y: 9, k: 1 } ) );
		rerender( { key: 'newspack-nodes:debug:scopeB' } );
		act( () => jest.advanceTimersByTime( 500 ) );
		expect(
			window.localStorage.getItem( 'newspack-nodes:debug:scopeA' )
		).toBeNull();
		expect(
			window.localStorage.getItem( 'newspack-nodes:debug:scopeB' )
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
		expect( result.current.positions ).toEqual( { a: { x: 1, y: 2 } } );
		act( () => result.current.onViewportChange( { x: 1, y: 1, k: 1 } ) );
		expect( () =>
			act( () => jest.advanceTimersByTime( 200 ) )
		).not.toThrow();
		expect( () =>
			act( () => result.current.onSeedLayout( { z: { x: 0, y: 0 } } ) )
		).not.toThrow();
		expect( () => act( () => result.current.resetLayout() ) ).not.toThrow();
		window.localStorage.setItem = original;
	} );
} );
