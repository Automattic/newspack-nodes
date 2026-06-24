import { renderHook, render, act } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { useDebugFrame } from '../useDebugFrame';

const KEY = 'newspack-nodes:debug:test-frame';

// Capture the window-registered pointer handlers a single beginDrag installs.
function captureDrag( onPointerDown, downAt = { x: 0, y: 0 } ) {
	const handlers = {};
	const origAdd = window.addEventListener;
	window.addEventListener = ( name, fn ) => {
		handlers[ name ] = fn;
	};
	onPointerDown( {
		clientX: downAt.x,
		clientY: downAt.y,
		button: 0,
		target: { tagName: 'HEADER', closest: () => null },
		preventDefault: () => {},
	} );
	window.addEventListener = origAdd;
	return handlers;
}

// Build a pointerdown / move / up sequence on the header drag handler.
// `e.preventDefault` is a no-op so the hook can call it freely.
function fireDrag( onPointerDown, from, to ) {
	const down = {
		clientX: from.x,
		clientY: from.y,
		button: 0,
		target: { tagName: 'HEADER', closest: () => null },
		preventDefault: () => {},
	};
	const handlers = {};
	const origAdd = window.addEventListener;
	window.addEventListener = ( name, fn ) => {
		handlers[ name ] = fn;
	};
	onPointerDown( down );
	window.addEventListener = origAdd;
	act( () => {
		handlers.pointermove?.( {
			clientX: to.x,
			clientY: to.y,
			preventDefault: () => {},
		} );
	} );
	act( () => {
		handlers.pointerup?.( {
			clientX: to.x,
			clientY: to.y,
			preventDefault: () => {},
		} );
	} );
}

describe( 'useDebugFrame', () => {
	beforeEach( () => {
		window.localStorage.clear();
		// jsdom defaults window.innerWidth/Height to 1024x768 — make it explicit.
		Object.defineProperty( window, 'innerWidth', {
			value: 1200,
			writable: true,
		} );
		Object.defineProperty( window, 'innerHeight', {
			value: 800,
			writable: true,
		} );
	} );

	it( 'returns a default frame and a style prop with concrete dimensions', () => {
		const { result } = renderHook( () => useDebugFrame( KEY ) );
		const { frame, style } = result.current;
		expect( frame ).toEqual(
			expect.objectContaining( {
				x: expect.any( Number ),
				y: expect.any( Number ),
				w: expect.any( Number ),
				h: expect.any( Number ),
			} )
		);
		expect( style ).toEqual(
			expect.objectContaining( {
				left: `${ frame.x }px`,
				top: `${ frame.y }px`,
				width: `${ frame.w }px`,
				height: `${ frame.h }px`,
			} )
		);
	} );

	it( 'header pointerdown→move→up shifts the frame by the delta', () => {
		// Start from a small frame in the center so a +50/+30 shift stays
		// inside the strict viewport bounds (otherwise the clamp eats it).
		window.localStorage.setItem(
			KEY,
			JSON.stringify( { x: 100, y: 100, w: 400, h: 300 } )
		);
		const { result } = renderHook( () => useDebugFrame( KEY ) );
		const { frame: initial } = result.current;
		fireDrag(
			result.current.onHeaderPointerDown,
			{ x: 0, y: 0 },
			{ x: 50, y: 30 }
		);
		expect( result.current.frame.x ).toBe( initial.x + 50 );
		expect( result.current.frame.y ).toBe( initial.y + 30 );
	} );

	it( 'drags via a direct transform during the move and commits the frame only on pointerup', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( { x: 100, y: 100, w: 400, h: 300 } )
		);
		let latest;
		let panelEl;
		function Harness() {
			const ref = useRef( null );
			latest = useDebugFrame( KEY, true, ref );
			return (
				<div
					data-testid="panel"
					ref={ ( n ) => {
						ref.current = n;
						panelEl = n;
					} }
					style={ latest.style }
					onPointerDown={ latest.onHeaderPointerDown }
				/>
			);
		}
		render( <Harness /> );
		const initial = latest.frame;

		const handlers = captureDrag( latest.onHeaderPointerDown );
		// During the move: the element gets a transform, the frame STATE does not
		// change (no per-frame React re-render of the heavy panel subtree).
		act( () => {
			handlers.pointermove( {
				clientX: 40,
				clientY: 25,
				preventDefault: () => {},
			} );
		} );
		expect( latest.frame ).toBe( initial );
		expect( panelEl.style.transform ).toBe( 'translate(40px, 25px)' );
		expect( panelEl.classList.contains( 'is-dragging' ) ).toBe( true );

		// On pointerup: the frame commits once and the transform is cleared.
		act( () => {
			handlers.pointerup( {
				clientX: 40,
				clientY: 25,
				preventDefault: () => {},
			} );
		} );
		expect( latest.frame.x ).toBe( initial.x + 40 );
		expect( latest.frame.y ).toBe( initial.y + 25 );
		expect( panelEl.style.transform ).toBe( '' );
		expect( panelEl.classList.contains( 'is-dragging' ) ).toBe( false );
	} );

	it( 'resizes the box directly during the drag (drag class on) and commits dimensions on pointerup', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( { x: 100, y: 100, w: 400, h: 300 } )
		);
		let latest;
		let panelEl;
		function Harness() {
			const ref = useRef( null );
			latest = useDebugFrame( KEY, true, ref );
			return (
				<div
					data-testid="panel"
					ref={ ( n ) => {
						ref.current = n;
						panelEl = n;
					} }
					style={ latest.style }
				/>
			);
		}
		render( <Harness /> );
		const initial = latest.frame;

		const handlers = captureDrag(
			latest.getResizeHandlers().se.onPointerDown
		);
		// During the resize: the box is written directly (no committed state
		// change), and the panel carries the shadow-lifting drag class.
		act( () => {
			handlers.pointermove( {
				clientX: 80,
				clientY: 60,
				preventDefault: () => {},
			} );
		} );
		expect( latest.frame ).toBe( initial );
		expect( panelEl.style.width ).toBe( '480px' );
		expect( panelEl.style.height ).toBe( '360px' );
		expect( panelEl.classList.contains( 'is-dragging' ) ).toBe( true );

		// On pointerup: the dimensions commit to state, the drag class clears.
		act( () => {
			handlers.pointerup( {
				clientX: 80,
				clientY: 60,
				preventDefault: () => {},
			} );
		} );
		expect( latest.frame.w ).toBe( initial.w + 80 );
		expect( latest.frame.h ).toBe( initial.h + 60 );
		expect( panelEl.classList.contains( 'is-dragging' ) ).toBe( false );
	} );

	it( 'persists the dragged frame to localStorage', () => {
		jest.useFakeTimers();
		try {
			const { result } = renderHook( () => useDebugFrame( KEY ) );
			fireDrag(
				result.current.onHeaderPointerDown,
				{ x: 0, y: 0 },
				{ x: 100, y: 100 }
			);
			// Persistence is debounced 200ms — drive the timer to fire it.
			act( () => jest.advanceTimersByTime( 200 ) );
			const stored = JSON.parse( window.localStorage.getItem( KEY ) );
			expect( stored ).toEqual( result.current.frame );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'rehydrates from localStorage on mount', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( { x: 12, y: 34, w: 500, h: 400 } )
		);
		const { result } = renderHook( () => useDebugFrame( KEY ) );
		expect( result.current.frame ).toEqual( {
			x: 12,
			y: 34,
			w: 500,
			h: 400,
		} );
	} );

	it( 'clamps a drag so the entire panel stays inside the viewport (strict)', () => {
		// Start near the right edge; try to drag the panel off-screen.
		window.localStorage.setItem(
			KEY,
			JSON.stringify( { x: 1100, y: 100, w: 500, h: 400 } )
		);
		const { result } = renderHook( () => useDebugFrame( KEY ) );
		fireDrag(
			result.current.onHeaderPointerDown,
			{ x: 0, y: 0 },
			{ x: 2000, y: 0 }
		);
		// Panel's right edge must not go past the viewport's right edge.
		const f = result.current.frame;
		expect( f.x + f.w ).toBeLessThanOrEqual( window.innerWidth );
		expect( f.x ).toBeGreaterThanOrEqual( 0 );
	} );

	it( 'snapshots the clamp bounds at gesture start (a mid-drag viewport shrink does not re-clamp)', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( { x: 100, y: 100, w: 400, h: 300 } )
		);
		const { result } = renderHook( () => useDebugFrame( KEY ) );
		// onPointerDown snapshots the bounds at the current 1200-wide viewport.
		const handlers = captureDrag( result.current.onHeaderPointerDown );
		act( () => {
			// Shrink the viewport mid-drag. The cached bounds must win — if the
			// clamp re-read the (now 600-wide) viewport per move, that's the
			// per-frame reflow we removed.
			window.innerWidth = 600;
			handlers.pointermove( {
				clientX: 700,
				clientY: 0,
				preventDefault: () => {},
			} );
		} );
		act( () => {
			handlers.pointerup( {
				clientX: 700,
				clientY: 0,
				preventDefault: () => {},
			} );
		} );
		// x = 100 + 700 = 800, clamped to the snapshotted right (1200) − w (400).
		// A live 600-wide read would instead clamp to 600 − 400 = 200.
		expect( result.current.frame.x ).toBe( 800 );
	} );

	it( 'toggleMaximize flips to fullscreen and restores the prior frame', () => {
		window.localStorage.setItem(
			KEY,
			JSON.stringify( { x: 100, y: 80, w: 600, h: 400 } )
		);
		const { result } = renderHook( () => useDebugFrame( KEY ) );
		act( () => result.current.toggleMaximize() );
		expect( result.current.frame ).toEqual( {
			x: 0,
			y: 0,
			w: window.innerWidth,
			h: window.innerHeight,
		} );
		act( () => result.current.toggleMaximize() );
		expect( result.current.frame ).toEqual( {
			x: 100,
			y: 80,
			w: 600,
			h: 400,
		} );
	} );

	it( 'resize from the SE corner adjusts width + height', () => {
		const { result } = renderHook( () => useDebugFrame( KEY ) );
		const { frame: before } = result.current;
		// Each handle exposes its own onPointerDown via getResizeHandlers().
		const handlers = result.current.getResizeHandlers();
		fireDrag( handlers.se.onPointerDown, { x: 0, y: 0 }, { x: 80, y: 60 } );
		expect( result.current.frame.w ).toBe( before.w + 80 );
		expect( result.current.frame.h ).toBe( before.h + 60 );
	} );

	it( 'resize from the W edge adjusts x + width (right edge stays put)', () => {
		const { result } = renderHook( () => useDebugFrame( KEY ) );
		const { frame: before } = result.current;
		const handlers = result.current.getResizeHandlers();
		fireDrag( handlers.w.onPointerDown, { x: 0, y: 0 }, { x: -50, y: 0 } );
		expect( result.current.frame.x ).toBe( before.x - 50 );
		expect( result.current.frame.w ).toBe( before.w + 50 );
	} );

	it( 'resize enforces a minimum size', () => {
		const { result } = renderHook( () => useDebugFrame( KEY ) );
		const handlers = result.current.getResizeHandlers();
		// Try to shrink from SE by an absurd amount — should clamp.
		fireDrag(
			handlers.se.onPointerDown,
			{ x: 0, y: 0 },
			{ x: -10000, y: -10000 }
		);
		expect( result.current.frame.w ).toBeGreaterThanOrEqual( 200 );
		expect( result.current.frame.h ).toBeGreaterThanOrEqual( 120 );
	} );
} );
