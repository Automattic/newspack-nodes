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

// The usable area on the page: viewport minus WP admin bar (top), admin
// menu (left), and the vertical scrollbar (right). Falls back to the raw
// viewport when the WP chrome isn't present (non-WP host). Used by BOTH
// the strict in-bounds clamp and the maximize so dragging and maximizing
// agree on what "inside" means. Pass { ignoreScrollbar: true } for the
// maximize path — we hide the body scrollbar there, so the panel can
// claim that strip too.
function getAvailableBounds( { ignoreScrollbar = false } = {} ) {
	const adminBar = document.getElementById( 'wpadminbar' );
	const adminMenu = document.getElementById( 'adminmenuwrap' );
	const top = adminBar ? adminBar.offsetHeight : 0;
	const left = adminMenu ? adminMenu.offsetWidth : 0;
	// innerWidth - clientWidth = vertical-scrollbar width (0 when none).
	// Guard against jsdom where clientWidth can be 0 — that would compute a
	// scrollbar of the full window width and collapse the bounds to zero.
	// Anything larger than 40px is obviously not a real scrollbar; ignore.
	let scrollbarW = 0;
	if ( ! ignoreScrollbar ) {
		const clientW = document.documentElement.clientWidth;
		const rawScrollbar = window.innerWidth - clientW;
		scrollbarW =
			clientW > 0 && rawScrollbar >= 0 && rawScrollbar <= 40
				? rawScrollbar
				: 0;
	}
	return {
		left,
		top,
		right: window.innerWidth - scrollbarW,
		bottom: window.innerHeight,
	};
}

// Strict in-bounds: the entire panel stays inside the AVAILABLE area
// (viewport minus admin chrome + scrollbar). If the panel is larger
// than that area (e.g. user shrunk the window), shrink it to fit;
// min-size still applies (the panel can't shrink below MIN_W x MIN_H).
//
// `bounds` lets a caller pass a pre-read box so we DON'T call getAvailableBounds
// here — it reads offsetHeight/offsetWidth/clientWidth, which force a synchronous
// reflow. Doing that on every pointermove of a drag stutters badly on a page
// whose layout is constantly dirtied (live dashboards); a static page never
// shows it. Drags snapshot the bounds once at gesture start and pass them in.
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
 * @return {{ frame: Object, style: Object, onHeaderPointerDown: Function, getResizeHandlers: Function, toggleMaximize: Function }} Frame state, an inline style for the panel, the header drag handler, a factory returning the 8 edge/corner handlers, and a toggleMaximize() that flips between the saved frame and a fullscreen frame.
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
		// Maximize claims the scrollbar strip too — the body-overflow:hidden
		// effect below hides the scrollbar, freeing that space.
		const b = getAvailableBounds( { ignoreScrollbar: true } );
		setFrame( {
			x: b.left,
			y: b.top,
			w: Math.max( MIN_W, b.right - b.left ),
			h: Math.max( MIN_H, b.bottom - b.top ),
		} );
		setMaximized( true );
	}, [ frame ] );

	// While maximized AND visible, suppress the page's vertical scrollbar
	// so it doesn't eat the panel's right edge. Restored when the panel
	// is un-maximized, hidden, or unmounted. The `visible` flag lets the
	// consumer (DebugOverlay) reflect open/close so the scrollbar comes
	// back the moment the X is clicked, even if the panel was maximized.
	useEffect( () => {
		if ( ! maximized || ! visible ) {
			return undefined;
		}
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = prev;
		};
	}, [ maximized, visible ] );

	// Re-clamp on viewport shrink so a previously-fitting panel stays inside.
	// While maximized, ignore the scrollbar (we've hidden it) so the panel
	// keeps claiming the full width.
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

	// The latest in-flight frame computed during a drag/resize. We mutate the
	// panel's DOM style directly per pointermove (cheap) and only push this to
	// React state ONCE on pointerup — so the heavy panel subtree (graph, tab
	// content) doesn't re-render every frame while dragging or resizing.
	const liveFrameRef = useRef( null );

	// Generic pointer-drag wrapper: a stream of dx/dy deltas to `apply`, with a
	// `commit` fired once on pointerup (where the per-drag React state update lands).
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
			// Snapshot the clamp bounds ONCE (the read forces a reflow; doing it per
			// pointermove stutters on a live page). They don't change mid-drag.
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
					// Composited translate, no React. The `is-dragging` class lifts
					// the panel's drop shadow (a 40px-blur shadow forces the page
					// BEHIND it to repaint as it moves). Restored on pointerup.
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
							// Real box resize (no transform — scaling stretched the
							// content). The `is-dragging` class lifts the drop shadow,
							// which is what made growing jank (the shadow repaints the
							// page behind); the panel's own content reflow is cheap.
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
