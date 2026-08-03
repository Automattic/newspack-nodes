import { renderHook, act } from '@testing-library/react';
import { useCanvasLayout } from '../useCanvasLayout';

const KEY = 'newspack-nodes:topology:test';
// a→b: autoLayout puts a at {60,80} (col0,row0), b at {300,80} (maxDepth,row0).
const GRAPH_AB = {
	nodes: [ { id: 'a' }, { id: 'b' } ],
	edges: [ { from: 'a', to: 'b' } ],
};
const GRAPH_ABC = {
	nodes: [ { id: 'a' }, { id: 'b' }, { id: 'c' } ],
	edges: [ { from: 'a', to: 'b' } ],
};

const serverLayout = () => ( {
	a: { x: 741, y: -389 },
	b: { x: -263, y: 947 },
} );

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
		// The initial autoLayout is deferred until the node set settles.
		act( () => jest.advanceTimersByTime( 300 ) );
		expect( result.current.positions ).toEqual( {
			a: { x: 60, y: 80 },
			b: { x: 300, y: 80 },
		} );
		expect( result.current.canReset ).toBe( false );
		expect(
			JSON.parse( window.localStorage.getItem( KEY ) ).positions
		).toEqual( { a: { x: 60, y: 80 }, b: { x: 300, y: 80 } } );
	} );

	it( 'defers the initial autoLayout until the streaming node set settles (no premature partial layout)', () => {
		// Initial autoLayout runs on the COMPLETE graph, else late node tucks.
		const { result, rerender } = render( {
			graph: { nodes: [ { id: 'a' } ], edges: [] },
		} );
		expect( result.current.positions ).toEqual( {} ); // still settling
		act( () =>
			rerender( {
				storageKey: KEY,
				ready: true,
				serverLayout: null,
				graph: GRAPH_AB,
			} )
		);
		expect( result.current.positions ).toEqual( {} ); // re-armed, settling
		act( () => jest.advanceTimersByTime( 300 ) );
		// b lands at DAG {300,80}, NOT column-tucked below a at {60,190}.
		expect( result.current.positions ).toEqual( {
			a: { x: 60, y: 80 },
			b: { x: 300, y: 80 },
		} );
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

	it( 'replaces malformed stored coordinates with a valid server layout', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: {
					a: null,
					b: { x: 117, y: -233 },
				},
				viewportDelta: null,
				modified: false,
			} )
		);

		const saved = serverLayout();
		const { result } = render( { serverLayout: saved } );

		expect( result.current.positions ).toEqual( saved );
		expect( JSON.parse( window.localStorage.getItem( KEY ) ) ).toEqual( {
			positions: saved,
			viewportDelta: null,
			modified: false,
		} );
	} );

	it( 'drops a stored coordinate that is not finite, keeping the rest', () => {
		// A NaN row serializes to null, so a browser that hit the auto-layout
		// NaN bug has one persisted. `modified` makes the dirty browser copy win
		// over any server layout, so without a sanitize on read those cards stay
		// off-graph forever — Reset Layout was the only way back.
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: {
					a: { x: 417, y: null },
					b: { x: 823, y: 651 },
				},
				viewportDelta: null,
				modified: true,
			} )
		);

		const { result } = render();

		expect( result.current.positions.b ).toEqual( { x: 823, y: 651 } );
		expect( Number.isFinite( result.current.positions.a?.x ) ).toBe( true );
		expect( Number.isFinite( result.current.positions.a?.y ) ).toBe( true );
	} );

	it( 'replaces a clean fallback with a complete late server layout', () => {
		const { result, rerender } = render( { graph: GRAPH_ABC } );
		act( () => jest.advanceTimersByTime( 300 ) );
		expect( result.current.positions ).toEqual( {
			a: { x: 60, y: 80 },
			b: { x: 300, y: 80 },
			c: { x: 300, y: 190 },
		} );
		expect( result.current.canReset ).toBe( false );
		expect(
			JSON.parse( window.localStorage.getItem( KEY ) ).modified
		).toBe( false );

		const viewport = { x: 11, y: 22, w: 333, h: 444 };
		const viewportDelta = { dcx: 55, dcy: -66, zoom: 1.75 };
		act( () => result.current.onViewportChange( viewport, viewportDelta ) );

		rerender( {
			storageKey: KEY,
			graph: GRAPH_ABC,
			ready: true,
			serverLayout: serverLayout(),
		} );

		const expected = {
			...serverLayout(),
			c: { x: -263, y: 1057 },
		};
		expect( result.current.positions ).toEqual( expected );
		expect( result.current.viewport ).toBe( viewport );
		expect( result.current.viewportDelta ).toBe( viewportDelta );
		expect( result.current.canReset ).toBe( false );
		expect( JSON.parse( window.localStorage.getItem( KEY ) ) ).toEqual( {
			positions: expected,
			viewportDelta,
			modified: false,
		} );
	} );

	it( 'preserves the complete dirty browser layout over a late server layout', () => {
		const { result, rerender } = render();
		act( () => jest.advanceTimersByTime( 300 ) );
		act( () =>
			result.current.onPositionChange( 'a', {
				x: 1237,
				y: -561,
			} )
		);
		const browserPositions = result.current.positions;
		expect( browserPositions ).toEqual( {
			a: { x: 1237, y: -561 },
			b: { x: 300, y: 80 },
		} );

		rerender( {
			storageKey: KEY,
			graph: GRAPH_AB,
			ready: true,
			serverLayout: serverLayout(),
		} );

		expect( result.current.positions ).toBe( browserPositions );
		expect( result.current.canReset ).toBe( true );
		expect( JSON.parse( window.localStorage.getItem( KEY ) ) ).toEqual( {
			positions: browserPositions,
			viewportDelta: null,
			modified: true,
		} );
	} );

	it( 'clears dirty when a late server layout acknowledges the browser map', () => {
		const { result, rerender } = render();
		act( () => jest.advanceTimersByTime( 300 ) );
		const saved = serverLayout();
		act( () => {
			for ( const [ id, position ] of Object.entries( saved ) ) {
				result.current.onPositionChange( id, position );
			}
		} );
		const browserPositions = result.current.positions;
		expect( browserPositions ).toEqual( saved );
		expect( result.current.canReset ).toBe( true );

		rerender( {
			storageKey: KEY,
			graph: GRAPH_AB,
			ready: true,
			serverLayout: serverLayout(),
		} );

		expect( result.current.positions ).toBe( browserPositions );
		expect( result.current.canReset ).toBe( false );
		expect( JSON.parse( window.localStorage.getItem( KEY ) ) ).toEqual( {
			positions: saved,
			viewportDelta: null,
			modified: false,
		} );
	} );

	it( 'keeps an already-applied matching clean server map by reference', () => {
		const { result, rerender } = render( {
			serverLayout: serverLayout(),
		} );
		const appliedPositions = result.current.positions;
		const persisted = window.localStorage.getItem( KEY );

		rerender( {
			storageKey: KEY,
			graph: GRAPH_AB,
			ready: true,
			serverLayout: serverLayout(),
		} );

		expect( result.current.positions ).toBe( appliedPositions );
		expect( result.current.canReset ).toBe( false );
		expect( window.localStorage.getItem( KEY ) ).toBe( persisted );
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
		act( () => jest.advanceTimersByTime( 300 ) ); // settle+run autoLayout
		// autoLayout a{60,80}, b{300,80}; left x60 → node tucks to {60,190}.
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
		// Auto-tucking an external node isn't a user edit; no Reset Layout.
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
		act( () => jest.advanceTimersByTime( 300 ) ); // initial layout settles
		act( () => result.current.onPositionChange( 'a', { x: 5, y: 5 } ) );
		expect( result.current.canReset ).toBe( true );
		act( () => result.current.resetLayout() );
		act( () => jest.advanceTimersByTime( 300 ) ); // re-init settles
		expect( result.current.positions ).toEqual( {
			a: { x: 60, y: 80 },
			b: { x: 300, y: 80 },
		} );
		expect( result.current.canReset ).toBe( false );
	} );

	it( 'markDirty sets canReset without moving any node, and persists modified', () => {
		const { result } = render();
		act( () => jest.advanceTimersByTime( 300 ) ); // initial layout settles
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
		act( () => jest.advanceTimersByTime( 300 ) ); // initial layout settles
		act( () => result.current.renamePosition( 'a', 'a2' ) );
		expect( result.current.positions.a2 ).toEqual( { x: 60, y: 80 } );
		expect( result.current.positions.a ).toBeUndefined();
		expect( result.current.canReset ).toBe( false );
	} );

	it( 'debounces viewport writes (200ms): persists the delta, keeps the live viewBox in memory', () => {
		const { result } = render();
		const vp = { x: 1, y: 2, w: 3, h: 4 };
		const delta = { dcx: 5, dcy: 6, zoom: 2 };
		act( () => result.current.onViewportChange( vp, delta ) );
		expect( result.current.viewport ).toEqual( vp );
		expect( result.current.viewportDelta ).toEqual( delta );
		act( () => jest.advanceTimersByTime( 200 ) );
		const stored = JSON.parse( window.localStorage.getItem( KEY ) );
		// Only the delta persists; viewBox is re-derived from it each session.
		expect( stored.viewportDelta ).toEqual( delta );
		expect( stored.viewport ).toBeUndefined();
	} );

	it( 'loads a stored viewportDelta and defers the viewBox to the freeze (viewport null)', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: { a: { x: 0, y: 0 } },
				viewportDelta: { dcx: 1, dcy: 2, zoom: 1.5 },
				modified: false,
			} )
		);
		const { result } = render();
		expect( result.current.viewportDelta ).toEqual( {
			dcx: 1,
			dcy: 2,
			zoom: 1.5,
		} );
		expect( result.current.viewport ).toBeNull();
	} );

	it( 'migrates an old stored viewBox (no delta) by re-fitting: both null', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( {
				positions: { a: { x: 0, y: 0 } },
				viewport: { x: 0, y: 0, w: 100, h: 100 },
				modified: false,
			} )
		);
		const { result } = render();
		expect( result.current.viewportDelta ).toBeNull();
		expect( result.current.viewport ).toBeNull();
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
		// Scope B's graph matches its stored layout (node z), as in the app.
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
		// B's saved layout must survive: b1 at {111,111}, no A ids leaked in.
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
