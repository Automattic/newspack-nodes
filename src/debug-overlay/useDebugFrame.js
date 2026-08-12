import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { holdPageScroll, releasePageScroll } from './pageScrollLock';
import { scrollbarWidth } from './scrollbarWidth';

const MIN_W = 200;
const MIN_H = 120;

// A maximized panel claims the scrollbar gutter, so it holds the lock too.
const MAXIMIZE = 'maximize';

// Resize handle bit masks: l/r/t/b; corner entries drive both axes.
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

// Usable area: viewport minus WP admin bar/menu + scrollbar (else viewport).
function getAvailableBounds( { ignoreScrollbar = false } = {} ) {
	const adminBar = document.getElementById( 'wpadminbar' );
	const adminMenu = document.getElementById( 'adminmenuwrap' );
	const top = adminBar ? adminBar.offsetHeight : 0;
	const left = adminMenu ? adminMenu.offsetWidth : 0;
	const scrollbarW = ignoreScrollbar ? 0 : scrollbarWidth();
	return {
		left,
		top,
		right: window.innerWidth - scrollbarW,
		bottom: window.innerHeight,
	};
}

// `bounds` = pre-read box; getAvailableBounds reflows (costly per pointermove).
function clampFrame( { x, y, w, h }, opts = {}, bounds = null ) {
	const b = bounds || getAvailableBounds( opts );
	const availW = b.right - b.left;
	const availH = b.bottom - b.top;
	const cw = Math.max( MIN_W, Math.min( w, availW ) );
	const ch = Math.max( MIN_H, Math.min( h, availH ) );
	const cx = Math.min(
		Math.max( b.left, x ),
		Math.max( b.left, b.right - cw )
	);
	const cy = Math.min(
		Math.max( b.top, y ),
		Math.max( b.top, b.bottom - ch )
	);
	return { x: cx, y: cy, w: cw, h: ch };
}

/**
 * Per-overlay floating-panel frame: position + size, draggable by the header
 * and resizable from edges + corners, persisted to localStorage so a moved
 * panel sticks across reloads. The hook owns its own pointer wiring (capture
 * on pointerdown, release on pointerup) so the consumer just spreads the
 * returned handlers onto the header + 8 handle divs.
 *
 * @param {string}  storageKey localStorage key (panel layout is keyed per dashboard).
 * @param {boolean} [visible]  Whether the panel is currently shown. When false while maximized, the page scrollbar is restored.
 * @param {Object}  [panelRef] Ref to the panel DOM node. When provided, drags/resizes mutate its style directly per pointermove and only commit to React state on pointerup (no per-frame re-render of the panel subtree).
 * @return {{ frame: { x: number, y: number, w: number, h: number }, style: Object, onHeaderPointerDown: ( event: import('react').PointerEvent ) => void, getResizeHandlers: Function, toggleMaximize: Function, maximized: boolean }} Frame state, an inline style for the panel, the header drag handler, a factory returning the 8 edge/corner handlers, a toggleMaximize() that flips between the saved frame and a fullscreen frame, and whether the panel is currently maximized.
 */
export function useDebugFrame( storageKey, visible = true, panelRef = null ) {
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
	const [ maximized, setMaximized ] = useState( false );

	const toggleMaximize = useCallback( () => {
		if ( preMaximizeRef.current ) {
			setFrame( clampFrame( preMaximizeRef.current ) );
			preMaximizeRef.current = null;
			setMaximized( false );
			return;
		}
		preMaximizeRef.current = frame;
		// Maximize claims the scrollbar strip; the lock below hides it.
		const b = getAvailableBounds( { ignoreScrollbar: true } );
		setFrame( {
			x: b.left,
			y: b.top,
			w: Math.max( MIN_W, b.right - b.left ),
			h: Math.max( MIN_H, b.bottom - b.top ),
		} );
		setMaximized( true );
	}, [ frame ] );

	// While maximized+visible, hide page scrollbar (it eats the right edge).
	useEffect( () => {
		if ( ! maximized || ! visible ) {
			return undefined;
		}
		holdPageScroll( MAXIMIZE );
		return () => releasePageScroll( MAXIMIZE );
	}, [ maximized, visible ] );

	// Re-clamp on viewport shrink; while maximized ignore (hidden) scrollbar.
	useEffect( () => {
		const onResize = () =>
			setFrame( ( prev ) =>
				clampFrame( prev, { ignoreScrollbar: maximized } )
			);
		window.addEventListener( 'resize', onResize );
		return () => window.removeEventListener( 'resize', onResize );
	}, [ maximized ] );

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

	// Latest in-flight frame; mutate DOM per move, commit React on pointerup.
	const liveFrameRef = useRef( null );

	// Generic pointer-drag: streams dx/dy to apply; commit fires on pointerup.
	const beginDrag = useCallback( ( e, apply, commit ) => {
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
			commit?.();
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
			// Snapshot clamp bounds ONCE — the read reflows; per-move stutters.
			const bounds = getAvailableBounds();
			beginDrag(
				e,
				( dx, dy ) => {
					const f = clampFrame(
						{
							x: start.x + dx,
							y: start.y + dy,
							w: start.w,
							h: start.h,
						},
						{},
						bounds
					);
					liveFrameRef.current = f;
					// Composited translate; is-dragging lifts repaint shadow.
					const el = panelRef && panelRef.current;
					if ( el ) {
						el.classList.add( 'is-dragging' );
						el.style.transform = `translate(${ f.x - start.x }px, ${
							f.y - start.y
						}px)`;
					}
				},
				() => {
					const el = panelRef && panelRef.current;
					if ( el ) {
						el.classList.remove( 'is-dragging' );
						el.style.transform = '';
					}
					if ( liveFrameRef.current ) {
						setFrame( liveFrameRef.current );
					}
					liveFrameRef.current = null;
				}
			);
		},
		[ beginDrag, frame, panelRef ]
	);

	const getResizeHandlers = useCallback( () => {
		const out = {};
		for ( const [ key, dirs ] of Object.entries( HANDLE_DIRS ) ) {
			out[ key ] = {
				onPointerDown: ( e ) => {
					const start = frame;
					// Snapshot the clamp bounds once — see the move handler.
					const bounds = getAvailableBounds();
					beginDrag(
						e,
						( dx, dy ) => {
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
							const f = clampFrame( { x, y, w, h }, {}, bounds );
							liveFrameRef.current = f;
							// Real box resize; is-dragging lifts the shadow.
							const el = panelRef && panelRef.current;
							if ( el ) {
								el.classList.add( 'is-dragging' );
								el.style.left = `${ f.x }px`;
								el.style.top = `${ f.y }px`;
								el.style.width = `${ f.w }px`;
								el.style.height = `${ f.h }px`;
							}
						},
						() => {
							const el = panelRef && panelRef.current;
							if ( el ) {
								el.classList.remove( 'is-dragging' );
							}
							if ( liveFrameRef.current ) {
								setFrame( liveFrameRef.current );
							}
							liveFrameRef.current = null;
						}
					);
				},
			};
		}
		return out;
	}, [ beginDrag, frame, panelRef ] );

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
		maximized,
	};
}
