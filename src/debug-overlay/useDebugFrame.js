import { useCallback, useEffect, useRef, useState } from '@wordpress/element';

const MIN_W = 200;
const MIN_H = 120;

// Eight resize handles — each entry's bit mask: l=left, r=right, t=top, b=bottom.
// Combined entries (corners) drive both axes at once.
const HANDLE_DIRS = {
	n: { t: 1 },
	s: { b: 1 },
	w: { l: 1 },
	e: { r: 1 },
	nw: { t: 1, l: 1 },
	ne: { t: 1, r: 1 },
	sw: { b: 1, l: 1 },
	se: { b: 1, r: 1 },
};

function defaultFrame() {
	const w = Math.min( 1100, Math.round( window.innerWidth * 0.7 ) );
	const h = Math.round( window.innerHeight * 0.7 );
	return {
		x: Math.max( 0, window.innerWidth - w - 24 ),
		y: Math.max( 0, window.innerHeight - h - 84 ),
		w,
		h,
	};
}

// Strict in-bounds: the entire panel stays inside the viewport. If the panel
// is larger than the viewport (e.g. user shrunk the window), shrink it to
// fit; min-size still applies (the panel can't shrink below MIN_W x MIN_H).
function clampFrame( { x, y, w, h } ) {
	const W = window.innerWidth;
	const H = window.innerHeight;
	const cw = Math.max( MIN_W, Math.min( w, W ) );
	const ch = Math.max( MIN_H, Math.min( h, H ) );
	const cx = Math.min( Math.max( 0, x ), Math.max( 0, W - cw ) );
	const cy = Math.min( Math.max( 0, y ), Math.max( 0, H - ch ) );
	return { x: cx, y: cy, w: cw, h: ch };
}

/**
 * Per-overlay floating-panel frame: position + size, draggable by the header
 * and resizable from edges + corners, persisted to localStorage so a moved
 * panel sticks across reloads. The hook owns its own pointer wiring (capture
 * on pointerdown, release on pointerup) so the consumer just spreads the
 * returned handlers onto the header + 8 handle divs.
 *
 * @param {string} storageKey localStorage key (panel layout is keyed per dashboard).
 * @return {{ frame: Object, style: Object, onHeaderPointerDown: Function, getResizeHandlers: Function, toggleMaximize: Function }} Frame state, an inline style for the panel, the header drag handler, a factory returning the 8 edge/corner handlers, and a toggleMaximize() that flips between the saved frame and a fullscreen frame.
 */
export function useDebugFrame( storageKey ) {
	const [ frame, setFrame ] = useState( () => {
		try {
			const raw = window.localStorage.getItem( storageKey );
			if ( raw ) {
				// Clamp in case the viewport shrank between sessions.
				return clampFrame( JSON.parse( raw ) );
			}
		} catch ( _e ) {
			// localStorage disabled / malformed — fall through to defaults.
		}
		return defaultFrame();
	} );

	// Saved frame for un-maximize. `null` = not currently maximized.
	const preMaximizeRef = useRef( null );

	const toggleMaximize = useCallback( () => {
		if ( preMaximizeRef.current ) {
			setFrame( clampFrame( preMaximizeRef.current ) );
			preMaximizeRef.current = null;
			return;
		}
		preMaximizeRef.current = frame;
		setFrame( {
			x: 0,
			y: 0,
			w: window.innerWidth,
			h: window.innerHeight,
		} );
	}, [ frame ] );

	// Re-clamp on viewport shrink so a previously-fitting panel stays inside.
	useEffect( () => {
		const onResize = () => setFrame( ( prev ) => clampFrame( prev ) );
		window.addEventListener( 'resize', onResize );
		return () => window.removeEventListener( 'resize', onResize );
	}, [] );

	const saveTimer = useRef( null );
	useEffect( () => {
		if ( saveTimer.current ) {
			clearTimeout( saveTimer.current );
		}
		saveTimer.current = setTimeout( () => {
			try {
				window.localStorage.setItem(
					storageKey,
					JSON.stringify( frame )
				);
			} catch ( _e ) {
				// localStorage disabled / quota — in-session only.
			}
		}, 200 );
		return () => {
			if ( saveTimer.current ) {
				clearTimeout( saveTimer.current );
			}
		};
	}, [ frame, storageKey ] );

	// Generic pointer-drag wrapper: a stream of dx/dy deltas to `apply`.
	const beginDrag = useCallback( ( e, apply ) => {
		if ( e.button !== undefined && e.button !== 0 ) {
			return;
		}
		const startX = e.clientX;
		const startY = e.clientY;
		const onMove = ( ev ) => {
			ev.preventDefault();
			apply( ev.clientX - startX, ev.clientY - startY );
		};
		const onUp = ( ev ) => {
			ev.preventDefault?.();
			window.removeEventListener( 'pointermove', onMove );
			window.removeEventListener( 'pointerup', onUp );
		};
		window.addEventListener( 'pointermove', onMove );
		window.addEventListener( 'pointerup', onUp );
		e.preventDefault?.();
	}, [] );

	const onHeaderPointerDown = useCallback(
		( e ) => {
			// Don't start a drag from interactive header controls.
			const tag = e.target && e.target.tagName;
			if (
				tag === 'SELECT' ||
				tag === 'BUTTON' ||
				tag === 'INPUT' ||
				tag === 'OPTION'
			) {
				return;
			}
			if ( e.target && e.target.closest ) {
				if (
					e.target.closest( 'select' ) ||
					e.target.closest( 'button' ) ||
					e.target.closest( 'input' )
				) {
					return;
				}
			}
			const start = frame;
			beginDrag( e, ( dx, dy ) => {
				setFrame(
					clampFrame( {
						x: start.x + dx,
						y: start.y + dy,
						w: start.w,
						h: start.h,
					} )
				);
			} );
		},
		[ beginDrag, frame ]
	);

	const getResizeHandlers = useCallback( () => {
		const out = {};
		for ( const [ key, dirs ] of Object.entries( HANDLE_DIRS ) ) {
			out[ key ] = {
				onPointerDown: ( e ) => {
					const start = frame;
					beginDrag( e, ( dx, dy ) => {
						let { x, y, w, h } = start;
						if ( dirs.l ) {
							const newW = Math.max( MIN_W, w - dx );
							x = x + ( w - newW );
							w = newW;
						}
						if ( dirs.r ) {
							w = Math.max( MIN_W, w + dx );
						}
						if ( dirs.t ) {
							const newH = Math.max( MIN_H, h - dy );
							y = y + ( h - newH );
							h = newH;
						}
						if ( dirs.b ) {
							h = Math.max( MIN_H, h + dy );
						}
						setFrame( clampFrame( { x, y, w, h } ) );
					} );
				},
			};
		}
		return out;
	}, [ beginDrag, frame ] );

	const style = {
		left: `${ frame.x }px`,
		top: `${ frame.y }px`,
		width: `${ frame.w }px`,
		height: `${ frame.h }px`,
	};

	return {
		frame,
		style,
		onHeaderPointerDown,
		getResizeHandlers,
		toggleMaximize,
	};
}
