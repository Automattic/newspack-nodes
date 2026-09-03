/**
 * Geometry for the debug overlay's floating panel: where it sits, how big it
 * is, and what a drag or a resize does to it.
 *
 * The panel is `position: fixed` and every box property it has arrives as an
 * inline style, so this hook is the only thing deciding where the panel is.
 * Every frame it produces is clamped inside the usable viewport, because the
 * WordPress admin bar and menu are fixed elements the panel would slide
 * under, taking the header — its only drag surface — with it. The frame is
 * saved per key, so a moved panel comes back where it was left.
 *
 * A gesture does not run through React. Each pointermove writes the panel
 * element's style directly and only pointerup commits a frame to state,
 * because re-rendering the panel's subtree per move stutters. The panel also
 * drops its shadow for the length of the gesture (`is-dragging`): the shadow
 * reaches well past the panel, so every frame it moves repaints the blurred
 * page behind it, and that cost grows with how busy the page underneath is.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { holdPageScroll, releasePageScroll } from './pageScrollLock';
import { scrollbarWidth } from './scrollbarWidth';

/**
 * Narrowest a resize may leave the panel, in px. The floor keeps the header
 * and the eight handles big enough to grab, so a panel shrunk to the minimum
 * can still be dragged and resized back out.
 */
const MIN_W = 200;

/** Shortest a resize may leave the panel, in px. */
const MIN_H = 120;

/**
 * Reason key for the page-scroll hold a maximized panel takes.
 *
 * A maximized panel covers the scrollbar gutter, so it hides the page
 * scrollbar instead of leaving one drawn across its right edge. The pointer
 * hold uses its own key, and `pageScrollLock` restores the page only when the
 * last reason lets go, so neither hold can strand the other.
 */
const MAXIMIZE = 'maximize';

/**
 * Which edges each resize handle moves, keyed by its compass name.
 *
 * A corner carries both of its edges, so the resize math reads `l`, `r`, `t`
 * and `b` off one entry with no branch per handle, and `getResizeHandlers`
 * walks this map to build all eight handlers.
 *
 * @type {Object<string,{l?:number,r?:number,t?:number,b?:number}>}
 */
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

/**
 * The props for the eight resize handles, keyed as `HANDLE_DIRS` is.
 *
 * Each entry is spread onto its handle element, so the handler takes the
 * element's own pointerdown and starts the gesture that moves those edges.
 *
 * @typedef {Object<string,{onPointerDown:(event:import('react').PointerEvent)=>void}>} ResizeHandlers
 */

/**
 * Build the frame a panel opens with when nothing is stored for its key.
 *
 * The panel takes 70% of the viewport, capped at 1100px wide so a wide screen
 * gets a window rather than a takeover, and sits in the bottom-right corner
 * clear of the button that opens it: 24px in from the right, matching that
 * button's own offset, and 84px up from the bottom, which clears its 48px
 * height and leaves a gap.
 *
 * @return {{x:number,y:number,w:number,h:number}} Frame in viewport px.
 */
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

/**
 * Measure where the panel may sit: the viewport, less the WordPress admin
 * chrome and the scrollbar gutter.
 *
 * The admin bar and the admin menu are fixed elements the panel would slide
 * under, so their height and width come off the top and the left edge. The
 * gutter comes off the right, which keeps the east handles clear of the
 * scrollbar. Chrome that is absent — a front-end page — measures zero and
 * gives that edge back.
 *
 * @param {Object}  [root0]                 Options.
 * @param {boolean} [root0.ignoreScrollbar] Count the gutter as usable. A maximized panel does, because the page-scroll lock it holds has hidden the scrollbar. Absent, the gutter comes off the right edge.
 * @return {{left:number,top:number,right:number,bottom:number}} Usable box in viewport px.
 */
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

/**
 * Fit a frame inside the usable bounds — size first, then position.
 *
 * Clamping the size first lets each axis pin the frame between the near edge
 * and the far edge minus the size that will actually be applied. The outer
 * `Math.max` on each far edge keeps the near edge winning when the bounds are
 * narrower than the minimum size: the panel then overhangs the far edge,
 * where the alternative puts its origin off-screen and the header out of
 * reach.
 *
 * @param {{x:number,y:number,w:number,h:number}}                root0  Frame to fit.
 * @param {Object}                                               opts   Forwarded to `getAvailableBounds` when it has to measure.
 * @param {?{left:number,top:number,right:number,bottom:number}} bounds Bounds read once at gesture start. `getAvailableBounds` reads `offsetHeight` and `clientWidth`, which force a synchronous reflow, and paying that per pointermove stutters on a dashboard that keeps dirtying its own layout.
 * @return {{x:number,y:number,w:number,h:number}} The fitted frame.
 */
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
 * Own one floating panel's frame: its position and size, dragged by the
 * header, resized from its edges and corners, and persisted to localStorage
 * so a moved panel comes back where it was left.
 *
 * The hook wires the pointer itself. A gesture puts `pointermove` and
 * `pointerup` on `window` rather than on the handle, so a pointer that
 * outruns the panel keeps dragging it, and the consumer only spreads the
 * returned handlers onto the header and the eight handle elements.
 *
 * @param {string}  storageKey localStorage key. Panel layout is keyed per dashboard.
 * @param {boolean} [visible]  Whether the panel is on screen. Going false while maximized hands the page its scrollbar back.
 * @param {Object}  [panelRef] Ref to the panel DOM node. Given one, a gesture mutates its style per pointermove and commits to React state only on pointerup; without one, nothing moves until the gesture ends.
 * @return {{frame:{x:number,y:number,w:number,h:number},style:Object,onHeaderPointerDown:(event:import('react').PointerEvent)=>void,getResizeHandlers:()=>ResizeHandlers,toggleMaximize:()=>void,maximized:boolean}} The frame, the inline style carrying it, the header drag handler, a factory returning the eight edge and corner handlers, a toggle between the saved frame and a full-bleed one, and whether the panel is maximized now.
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
			// A disabled store or malformed JSON means the default frame.
		}
		return defaultFrame();
	} );

	// The frame to restore on un-maximize; null while not maximized.
	const preMaximizeRef = useRef( null );
	const [ maximized, setMaximized ] = useState( false );

	/**
	 * Flip between the saved frame and one filling the usable bounds.
	 *
	 * The restore runs back through `clampFrame`, because the viewport can
	 * shrink while the panel is maximized and the saved frame would then put
	 * the header out of reach.
	 *
	 * @return {void}
	 */
	const toggleMaximize = useCallback( () => {
		if ( preMaximizeRef.current ) {
			setFrame( clampFrame( preMaximizeRef.current ) );
			preMaximizeRef.current = null;
			setMaximized( false );
			return;
		}
		preMaximizeRef.current = frame;
		// The panel takes the gutter; the effect below hides the scrollbar.
		const b = getAvailableBounds( { ignoreScrollbar: true } );
		setFrame( {
			x: b.left,
			y: b.top,
			w: Math.max( MIN_W, b.right - b.left ),
			h: Math.max( MIN_H, b.bottom - b.top ),
		} );
		setMaximized( true );
	}, [ frame ] );

	// Hide the page scrollbar while a shown panel covers its gutter.
	useEffect( () => {
		if ( ! maximized || ! visible ) {
			return undefined;
		}
		holdPageScroll( MAXIMIZE );
		return () => releasePageScroll( MAXIMIZE );
	}, [ maximized, visible ] );

	// A resized viewport re-clamps; maximized ignores the hidden gutter.
	useEffect( () => {
		const onResize = () =>
			setFrame( ( prev ) =>
				clampFrame( prev, { ignoreScrollbar: maximized } )
			);
		window.addEventListener( 'resize', onResize );
		return () => window.removeEventListener( 'resize', onResize );
	}, [ maximized ] );

	// A window resize commits a frame per event, so debounce the write.
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
				// A disabled or full store keeps the frame in-session.
			}
		}, 200 );
		return () => {
			if ( saveTimer.current ) {
				clearTimeout( saveTimer.current );
			}
		};
	}, [ frame, storageKey ] );

	// The frame each move writes to the DOM and pointerup commits to state.
	const liveFrameRef = useRef( null );

	/**
	 * Run one pointer gesture, from pointerdown to pointerup.
	 *
	 * Only the primary button starts one, so a right-click on the header
	 * opens its menu instead of dragging the panel. Both handlers go on
	 * `window`, which is what keeps a gesture alive once the pointer has left
	 * the small element it started on.
	 *
	 * @param {import('react').PointerEvent} e      The pointerdown.
	 * @param {(dx:number,dy:number)=>void}  apply  Called per move with the offset from the pointerdown, never with absolute coordinates.
	 * @param {?()=>void}                    commit Called once on pointerup.
	 * @return {void}
	 */
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

	/**
	 * Start a move from the header, dragging the panel by its whole box.
	 *
	 * The header carries the panel's controls, so a pointerdown on a select,
	 * button or input — or on anything inside one — starts no drag: a drag
	 * would preventDefault its way through the click that control exists for.
	 * The `closest` guard is what catches the icon inside a button.
	 *
	 * @param {import('react').PointerEvent} e The pointerdown.
	 * @return {void}
	 */
	const onHeaderPointerDown = useCallback(
		( e ) => {
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
			// Read the clamp bounds once; the read reflows. See clampFrame.
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
					// A move needs no layout, so translate rather than left.
					const el = panelRef && panelRef.current;
					if ( el ) {
						el.classList.add( 'is-dragging' );
						el.style.transform = `translate(${ f.x - start.x }px, ${
							f.y - start.y
						}px)`;
					}
				},
				() => {
					// The frame commits the offset; drop the transform.
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

	/**
	 * Build the eight edge and corner handlers, keyed as `HANDLE_DIRS` is.
	 *
	 * Each handler moves the edges its key names. A west or north drag changes
	 * the origin and the size together, so the opposite edge stays put, and it
	 * stops moving once the size has reached its minimum.
	 *
	 * @return {ResizeHandlers} Props to spread onto each handle element.
	 */
	const getResizeHandlers = useCallback( () => {
		/** @type {ResizeHandlers} */
		const out = {};
		for ( const [ key, dirs ] of Object.entries( HANDLE_DIRS ) ) {
			out[ key ] = {
				onPointerDown: ( e ) => {
					const start = frame;
					// Read the bounds once; the read reflows. See clampFrame.
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
							// A resize needs the real box, not a transform.
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

	// The panel is position:fixed with no CSS box; this is the whole box.
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
