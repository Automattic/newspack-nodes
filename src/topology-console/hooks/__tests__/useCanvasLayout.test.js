import { renderHook, act } from '@testing-library/react';
import { useCanvasLayout } from '../useCanvasLayout';

const KEY = 'newspack-nodes:topology:test';
// a -> b: autoLayout puts a at {60,80} (col0,row0), b at {300,80} (maxDepth,row0).
const GRAPH_AB = {
	nodes: [ { id: 'a' }, { id: 'b' } ],
	edges: [ { from: 'a', to: 'b' } ],
};

function render( props ) {
	return renderHook( ( p ) => useCanvasLayout( p ), {
		initialProps: {
			storageKey: KEY,
			graph: GRAPH_AB,
			ready: true,
			serverLayout: null,
			...props,
		},
	} );
}

describe( 'useCanvasLayout', () => {
	beforeEach( () => {
		window.localStorage.clear();
		jest.useFakeTimers();
	} );
	afterEach( () => jest.useRealTimers() );

	it( 'is inert until ready (empty positions, no init, no write)', () => {
		const { result } = render( { ready: false } );
		expect( result.current.positions ).toEqual( {} );
		expect( result.current.canReset ).toBe( false );
		expect( window.localStorage.getItem( KEY ) ).toBeNull();
	} );

	it( 'runs autoLayout exactly once on ready with empty storage, modified=false', () => {
		const { result } = render();
		expect( result.current.positions ).toEqual( {
			a: { x: 60, y: 80 },
			b: { x: 300, y: 80 },
		} );
		expect( result.current.canReset ).toBe( false );
		expect(
			JSON.parse( window.localStorage.getItem( KEY ) ).positions
		).toEqual( { a: { x: 60, y: 80 }, b: { x: 300, y: 80 } } );
	} );

	it( 'does not init on an empty graph', () => {
		const { result } = render( { graph: { nodes: [], edges: [] } } );
		expect( result.current.positions ).toEqual( {} );
		expect( window.localStorage.getItem( KEY ) ).toBeNull();
	} );

	it( 'adopts a stored layout instead of running autoLayout', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } },
				viewport: null,
				modified: true,
			} )
		);
		const { result } = render();
		expect( result.current.positions ).toEqual( {
			a: { x: 1, y: 1 },
			b: { x: 2, y: 2 },
		} );
		expect( result.current.canReset ).toBe( true );
	} );

	it( 'adopts a serverLayout (worker topology) over autoLayout', () => {
		const { result } = render( {
			serverLayout: { a: { x: 7, y: 7 }, b: { x: 8, y: 8 } },
		} );
		expect( result.current.positions ).toEqual( {
			a: { x: 7, y: 7 },
			b: { x: 8, y: 8 },
		} );
		expect( result.current.canReset ).toBe( false );
	} );

	it( 'onPositionChange updates the entry, sets canReset, persists', () => {
		const { result } = render();
		act( () => result.current.onPositionChange( 'a', { x: 500, y: 500 } ) );
		expect( result.current.positions.a ).toEqual( { x: 500, y: 500 } );
		expect( result.current.canReset ).toBe( true );
		expect(
			JSON.parse( window.localStorage.getItem( KEY ) ).positions.a
		).toEqual( { x: 500, y: 500 } );
	} );

	it( 'tucks a newly-appeared node below the left-most-then-bottom-most, WITHOUT marking modified', () => {
		const { result, rerender } = render();
		// autoLayout: a{60,80}, b{300,80}. left-most col = x60 (just a) → new node at {60,190}.
		rerender( {
			storageKey: KEY,
			ready: true,
			serverLayout: null,
			graph: {
				nodes: [ { id: 'a' }, { id: 'b' }, { id: 'c' } ],
				edges: [ { from: 'a', to: 'b' } ],
			},
		} );
		expect( result.current.positions.c ).toEqual( { x: 60, y: 190 } );
		// Auto-tucking an externally-added node is NOT a user modification — the
		// graph can change from outside (the shared Core gains nodes when another
		// view/tab mounts), so Reset Layout must not surface for it.
		expect( result.current.canReset ).toBe( false );
	} );

	it( 'keeps a pre-recorded drop position instead of tucking', () => {
		const { result, rerender } = render();
		act( () => result.current.onPositionChange( 'c', { x: 900, y: 900 } ) );
		rerender( {
			storageKey: KEY,
			ready: true,
			serverLayout: null,
			graph: {
				nodes: [ { id: 'a' }, { id: 'b' }, { id: 'c' } ],
				edges: [ { from: 'a', to: 'b' } ],
			},
		} );
		expect( result.current.positions.c ).toEqual( { x: 900, y: 900 } );
	} );

	it( 'resetLayout wipes storage then re-runs autoLayout once on the next render', () => {
		const { result } = render();
		act( () => result.current.onPositionChange( 'a', { x: 5, y: 5 } ) );
		expect( result.current.canReset ).toBe( true );
		act( () => result.current.resetLayout() );
		// Re-init fires from the cleared state.
		expect( result.current.positions ).toEqual( {
			a: { x: 60, y: 80 },
			b: { x: 300, y: 80 },
		} );
		expect( result.current.canReset ).toBe( false );
	} );

	it( 'markDirty sets canReset without moving any node, and persists modified', () => {
		const { result } = render();
		expect( result.current.canReset ).toBe( false );
		const before = result.current.positions;
		act( () => result.current.markDirty() );
		expect( result.current.canReset ).toBe( true );
		expect( result.current.positions ).toEqual( before );
		expect(
			JSON.parse( window.localStorage.getItem( KEY ) ).modified
		).toBe( true );
	} );

	it( 'markDirty is a no-op before init (positions still empty, nothing persisted)', () => {
		const { result } = render( { ready: false } );
		act( () => result.current.markDirty() );
		expect( result.current.canReset ).toBe( false );
		expect( window.localStorage.getItem( KEY ) ).toBeNull();
	} );

	it( 'renamePosition moves an entry, leaves canReset unchanged', () => {
		const { result } = render();
		act( () => result.current.renamePosition( 'a', 'a2' ) );
		expect( result.current.positions.a2 ).toEqual( { x: 60, y: 80 } );
		expect( result.current.positions.a ).toBeUndefined();
		expect( result.current.canReset ).toBe( false );
	} );

	it( 'debounces viewport writes (200ms)', () => {
		const { result } = render();
		act( () =>
			result.current.onViewportChange( { x: 1, y: 2, w: 3, h: 4 } )
		);
		expect( result.current.viewport ).toEqual( { x: 1, y: 2, w: 3, h: 4 } );
		act( () => jest.advanceTimersByTime( 200 ) );
		expect(
			JSON.parse( window.localStorage.getItem( KEY ) ).viewport
		).toEqual( { x: 1, y: 2, w: 3, h: 4 } );
	} );

	it( 'reloads when storageKey changes (scope switch)', () => {
		window.localStorage.setItem(
			'newspack-nodes:topology:B',
			JSON.stringify( {
				positions: { z: { x: 9, y: 9 } },
				viewport: null,
				modified: true,
			} )
		);
		const { result, rerender } = render();
		// Scope B's graph matches its stored layout (node z), as it would in app.
		rerender( {
			storageKey: 'newspack-nodes:topology:B',
			graph: { nodes: [ { id: 'z' } ], edges: [] },
			ready: true,
			serverLayout: null,
		} );
		expect( result.current.positions ).toEqual( { z: { x: 9, y: 9 } } );
		expect( result.current.canReset ).toBe( true );
	} );

	it( 'does not clobber the new scope when storageKey and graph switch together', () => {
		window.localStorage.setItem(
			'newspack-nodes:topology:B',
			JSON.stringify( {
				positions: { b1: { x: 111, y: 111 } },
				viewport: null,
				modified: false,
			} )
		);
		const GRAPH_B = {
			nodes: [ { id: 'b1' } ],
			edges: [],
		};
		const { result, rerender } = render();
		// Switch scope key AND graph in a single rerender.
		rerender( {
			storageKey: 'newspack-nodes:topology:B',
			graph: GRAPH_B,
			ready: true,
			serverLayout: null,
		} );
		const stored = JSON.parse(
			window.localStorage.getItem( 'newspack-nodes:topology:B' )
		);
		// B's saved layout must survive: b1 at {111,111}, no A node ids leaked in.
		expect( stored.positions ).toEqual( { b1: { x: 111, y: 111 } } );
		expect( stored.modified ).toBe( false );
		expect( result.current.positions ).toEqual( {
			b1: { x: 111, y: 111 },
		} );
		expect( result.current.canReset ).toBe( false );
	} );

	it( 'survives localStorage.setItem throwing', () => {
		const original = window.localStorage.setItem;
		window.localStorage.setItem = jest.fn( () => {
			throw new Error( 'quota' );
		} );
		expect( () => render() ).not.toThrow();
		window.localStorage.setItem = original;
	} );
} );
