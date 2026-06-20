/**
 * SchematicCanvas — raw SVG drafting-room canvas.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';

import { X_PAD, X_STEP, Y_PAD, Y_STEP } from '../utils/autoLayout';
import {
	viewportCull,
	isEdgeVisible,
	clipSegmentExit,
} from '../utils/viewportCull';

const NODE_W = 196;
const NODE_H = 84;
const PORT_R = 4.5;
// Movement (SVG units) before a pointer-down counts as a drag, not a click.
const DRAG_THRESHOLD = 3;

// Convert pointer (viewport) coords to SVG coords via the CTM scale.
function screenToSvg( svg, clientX, clientY ) {
	const pt = svg.createSVGPoint();
	pt.x = clientX;
	pt.y = clientY;
	const ctm = svg.getScreenCTM();
	return ctm
		? pt.matrixTransform( ctm.inverse() )
		: { x: clientX, y: clientY };
}

function compactCount( count ) {
	if ( count === null || count === undefined ) {
		return '—';
	}
	return count.toLocaleString();
}

function edgePath( a, b ) {
	const x1 = a.position.x + NODE_W;
	const y1 = a.position.y + NODE_H / 2;
	const x2 = b.position.x;
	const y2 = b.position.y + NODE_H / 2;
	// Cubic bezier S-curve so edge source/destination read clearly.
	const dx = Math.max( 60, Math.abs( x2 - x1 ) * 0.5 );
	const c1x = x1 + dx;
	const c2x = x2 - dx;
	return `M ${ x1 },${ y1 } C ${ c1x },${ y1 } ${ c2x },${ y2 } ${
		x2 - 6
	},${ y2 }`;
}

// Padded tight bbox of every node. The width/height floor caps the
// effective zoom so small graphs don't autofit to giant nodes.
const CENTER_PAD = 80;
// Fallback (only used when the canvas hasn't been measured yet) — picked to
// match a roughly desktop-sized panel. Once we know the actual canvas pixel
// size we use THAT as the minimum, so the autofit never zooms the graph
// smaller than 1:1 (a 1-node graph stays node-sized regardless of panel size).
const AUTOFIT_FALLBACK_W = 1280;
const AUTOFIT_FALLBACK_H = 720;
function tightViewBoxFor( nodes, canvasSize = null ) {
	const minW = canvasSize?.w || AUTOFIT_FALLBACK_W;
	const minH = canvasSize?.h || AUTOFIT_FALLBACK_H;
	if ( ! nodes.length ) {
		return `0 0 ${ minW } ${ minH }`;
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for ( const n of nodes ) {
		minX = Math.min( minX, n.position.x );
		minY = Math.min( minY, n.position.y );
		maxX = Math.max( maxX, n.position.x + NODE_W );
		maxY = Math.max( maxY, n.position.y + NODE_H );
	}
	const bboxW = maxX - minX + CENTER_PAD * 2;
	const bboxH = maxY - minY + CENTER_PAD * 2;
	// minW/H is the canvas pixel size — using it as the floor pins the autofit
	// at native zoom (1 SVG unit = 1 canvas px) for small graphs. Larger graphs
	// stretch the viewBox past the canvas, zooming out as before.
	const w = Math.max( minW, bboxW );
	const h = Math.max( minH, bboxH );
	// Center the (possibly enlarged) viewBox on the bbox center.
	const centerX = ( minX + maxX ) / 2;
	const centerY = ( minY + maxY ) / 2;
	const x = centerX - w / 2;
	const y = centerY - h / 2;
	return `${ x } ${ y } ${ w } ${ h }`;
}

// Wheel zoom step (multiplicative), cursor-anchored.
const ZOOM_STEP = 1.12;
// How far past the whole-graph fit you can zoom OUT.
const ZOOM_MIN = 0.25;
// Deepest zoom-IN, as an ABSOLUTE scale (CSS px per world unit) so a giant graph
// can still be zoomed in to read individual cards — not capped relative to the
// (tiny) whole-graph fit. A node is NODE_W wide, so 3 px/unit ≈ a 588px card.
const SCALE_MAX = 3;
// Floor a node's on-screen size to this many CSS px so a card never shrinks to a
// sub-pixel rect that some browsers (Firefox) drop entirely. At a tiny scale the
// bare rect is enlarged in world units so it still paints ~2px.
const MIN_NODE_PX = 2;
// Render this fraction of a viewport of off-screen nodes on each side so panning
// scrolls smoothly and a narrow column doesn't blink out when nudged sideways.
const NODE_OVERSCAN = 0.5;

// Arrow-key pan: fraction of the viewport shifted per keypress (hold to repeat),
// and the faster shift+arrow step. Keyed by arrow → [dx, dy] sign.
const PAN_STEP = 0.08;
const PAN_STEP_FAST = 0.25;
const ARROW_PAN = {
	ArrowLeft: [ -1, 0 ],
	ArrowRight: [ 1, 0 ],
	ArrowUp: [ 0, -1 ],
	ArrowDown: [ 0, 1 ],
};

// Above this many on-screen edges, suppress the perpetual edge-flow animation
// (the `--still` modifier). An infinite stroke-dashoffset animation re-rasterizes
// every dashed bezier every frame — fine for a handful, but hundreds peg the
// browser's raster threads (Firefox especially). A static graph layer-caches.
const EDGE_FLOW_MAX = 40;

// Bloom blur radius in SCREEN px (per theme). The SVG filter's stdDeviation is in
// world units, so it's divided by the px/world scale each render to hold a
// constant on-screen glow across zoom.
const BLOOM_STDDEV_PX = { crt: 5, neo: 4 };
// stdDeviation (world units) for a screen-constant glow; 0 when unmeasured
// (scale === Infinity) so jsdom/first-render emit a no-op blur.
function bloomStdDev( px, scale ) {
	return Number.isFinite( scale ) && scale > 0
		? ( px / scale ).toFixed( 2 )
		: 0;
}

// Parse "x y w h" into an object; safe fallback on malformed input.
function parseViewBox( str ) {
	const parts = str.split( /\s+/ ).map( Number );
	if ( parts.length !== 4 || parts.some( Number.isNaN ) ) {
		return { x: 0, y: 0, w: 1280, h: 720 };
	}
	return { x: parts[ 0 ], y: parts[ 1 ], w: parts[ 2 ], h: parts[ 3 ] };
}

// Sparkline area inside each node card, auto-scaled to the window's max.
const SPARK_X = 11;
const SPARK_Y = 48;
const SPARK_W = 174; // NODE_W (196) - 11 - 11
const SPARK_H = 16;
// Must equal useGraphRates.js's RATE_HISTORY_MAX — drives the per-sample step.
const SPARK_HISTORY_MAX = 60;
function sparklinePath( history ) {
	if ( ! history || history.length < 2 ) {
		return null;
	}
	const max = Math.max( ...history, 1e-9 );
	const step = SPARK_W / ( SPARK_HISTORY_MAX - 1 );
	// Right-align: newest sample at the right edge, earlier ones walk left.
	const startIdx = SPARK_HISTORY_MAX - history.length;
	return history
		.map( ( v, i ) => {
			// Clamp negatives (counter reset) so they don't plot below the box.
			const safeV = v > 0 ? v : 0;
			const x = SPARK_X + ( startIdx + i ) * step;
			const y = SPARK_Y + SPARK_H - ( safeV / max ) * SPARK_H;
			return `${ i === 0 ? 'M' : 'L' } ${ x.toFixed( 2 ) },${ y.toFixed(
				2
			) }`;
		} )
		.join( ' ' );
}

// Per-node rate label; null below threshold so dead nodes don't show "0 /s".
function formatNodeRate( rate ) {
	if ( ! rate || rate < 0.05 ) {
		return null;
	}
	if ( rate >= 100 ) {
		return `${ Math.round( rate ) } /s`;
	}
	if ( rate >= 10 ) {
		return `${ rate.toFixed( 1 ) } /s`;
	}
	return `${ rate.toFixed( 2 ) } /s`;
}

export default function SchematicCanvas( {
	parsed,
	selectedId,
	onSelect,
	onDeselect,
	hoveredId,
	onHover,
	positionOverrides,
	onPositionChange,
	rateRef,
	// (parent bumps a changing prop to force a re-render; not read here)
	viewport,
	onViewportChange,
	// Gesture handlers. onDropNode receives SVG-space coords; onConnect fires
	// on OUT-port → IN-port drag. `interactive` gates the gesture machinery
	// (true in both live + edit); `editMode` gates only draft-specific
	// affordances (edge-select hit target, out-port styling).
	onDropNode,
	onConnect,
	interactive = true,
	editMode = false,
	selectedEdge = null,
	onSelectEdge,
	// Returning truthy skips the canvas's own deselect/autofit for this click.
	onBackgroundClickConsumed,
	// When true, a background click ONLY autofits — it never dismisses
	// (onBackgroundClickConsumed) or deselects, so the transcript/inspector
	// stay put. The console opts in; the overlay keeps the staged dismiss.
	backgroundClickAutofitsOnly = false,
	// shell_name → schema; drives port visibility (accepts_fill/has_target).
	classCatalog = {},
} ) {
	const edges = useMemo( () => parsed?.edges ?? [], [ parsed ] );
	// positionOverrides is the COMPLETE position map (owned by useCanvasLayout).
	// Render only nodes that have a position — a brand-new node may beat the
	// layout hook's placement by one frame; it appears the next frame.
	const nodes = useMemo(
		() =>
			( parsed?.nodes ?? [] )
				.filter( ( n ) => positionOverrides[ n.id ] )
				.map( ( n ) => ( {
					...n,
					position: positionOverrides[ n.id ],
				} ) ),
		[ parsed, positionOverrides ]
	);

	// Mirror of `nodes` for the freeze effect (keyed on length, reads identity).
	const nodesRef = useRef( nodes );
	nodesRef.current = nodes;

	// Active-drag state; snap + commit happen on pointerup.
	const [ drag, setDrag ] = useState( null );
	// Set when the pointer-down crossed the threshold; suppresses selection.
	const draggedRef = useRef( false );

	const displayNodes = useMemo( () => {
		if ( ! drag ) {
			return nodes;
		}
		return nodes.map( ( n ) =>
			n.id === drag.nodeId ? { ...n, position: drag.currentPos } : n
		);
	}, [ nodes, drag ] );

	const nodeById = useMemo( () => {
		const map = new Map();
		displayNodes.forEach( ( n ) => map.set( n.id, n ) );
		return map;
	}, [ displayNodes ] );
	// Parent-controlled viewport; `null` = autofit to the tight bbox.
	// Memoized so it's a stable dep for the freeze effect (a no-op when the
	// parent doesn't supply onViewportChange).
	const setViewport = useMemo(
		() => onViewportChange || ( () => {} ),
		[ onViewportChange ]
	);
	// Active pan drag on the empty canvas (stable start origin per move).
	const panRef = useRef( null );
	// Whether the pointer is over the canvas — gates arrow-key panning so the
	// document-level handler only steals arrows (and preventDefault) while the
	// canvas is hovered. Without this the debug overlay (which mounts this canvas
	// over an arbitrary admin page) would hijack the host page's arrow scrolling.
	const canvasHoverRef = useRef( false );

	// Debounce flag for beginDrag — see comment in beginDrag below.
	const beginDragGuardRef = useRef( false );

	// SVG ref for projecting HTML drop coords back into viewBox space.
	const svgRef = useRef( null );

	// Wire-drag state; port hits stopPropagation so this and pan don't fight.
	const [ wireDrag, setWireDrag ] = useState( null );
	// Mirror for window-level listeners that would otherwise read stale state.
	const wireDragRef = useRef( null );
	const updateWireDrag = useCallback( ( next ) => {
		wireDragRef.current = next;
		setWireDrag( next );
	}, [] );

	// Port hit radius (SVG units); well under node spacing.
	const PORT_HIT_R = 24;

	// Window-level wire-drag listeners. useCallback keeps their closures fresh
	// over nodes/onConnect so the attached listeners never read stale values.
	const handleWindowWireMove = useCallback(
		( e ) => {
			const current = wireDragRef.current;
			if ( ! current ) {
				return;
			}
			const svg = svgRef.current;
			if ( ! svg ) {
				return;
			}
			const local = screenToSvg( svg, e.clientX, e.clientY );
			// Snap to the nearest IN port within PORT_HIT_R (never the source node).
			let snapTargetId = null;
			let bestDist = PORT_HIT_R;
			for ( const n of nodes ) {
				if ( n.id === current.fromId ) {
					continue;
				}
				const px = n.position.x;
				const py = n.position.y + NODE_H / 2;
				const dx = local.x - px;
				const dy = local.y - py;
				const d = Math.sqrt( dx * dx + dy * dy );
				if ( d <= bestDist ) {
					bestDist = d;
					snapTargetId = n.id;
				}
			}
			updateWireDrag( {
				...current,
				x2: local.x,
				y2: local.y,
				hoveredId: snapTargetId,
			} );
		},
		[ nodes, updateWireDrag ]
	);

	const handleWindowWireUp = useCallback( () => {
		const current = wireDragRef.current;
		if ( ! current ) {
			return;
		}
		const { fromId, hoveredId: snapId } = current;
		updateWireDrag( null );
		if ( snapId && onConnect ) {
			onConnect( fromId, snapId );
		}
	}, [ onConnect, updateWireDrag ] );

	// Same pointerdown/mousedown dedupe as beginDrag (Safari post-drop).
	const portDownGuardRef = useRef( false );

	const handlePortPointerDown = useCallback(
		( nodeId, e ) => {
			if ( ! interactive || ! onConnect || e.button !== 0 ) {
				return;
			}
			if ( portDownGuardRef.current ) {
				// Stop the deduped duplicate so it doesn't also start a node drag.
				e.stopPropagation();
				return;
			}
			portDownGuardRef.current = true;
			setTimeout( () => {
				portDownGuardRef.current = false;
			}, 50 );
			e.stopPropagation();
			const svg = svgRef.current;
			if ( ! svg ) {
				return;
			}
			// Window-level listeners (not SVG capture): work in the Safari
			// post-drop case and keep reporting when the cursor leaves the SVG.
			const onMove = ( me ) => handleWindowWireMove( me );
			const onUp = ( me ) => {
				handleWindowWireUp( me );
				window.removeEventListener( 'mousemove', onMove );
				window.removeEventListener( 'mouseup', onUp );
			};
			window.addEventListener( 'mousemove', onMove );
			window.addEventListener( 'mouseup', onUp );
			const node = nodes.find( ( n ) => n.id === nodeId );
			if ( ! node ) {
				return;
			}
			const x1 = node.position.x + NODE_W;
			const y1 = node.position.y + NODE_H / 2;
			updateWireDrag( {
				fromId: nodeId,
				x1,
				y1,
				x2: x1,
				y2: y1,
				hoveredId: null,
			} );
		},
		[
			interactive,
			onConnect,
			nodes,
			updateWireDrag,
			handleWindowWireMove,
			handleWindowWireUp,
		]
	);

	const handleDragOver = useCallback(
		( e ) => {
			if ( ! interactive ) {
				return;
			}
			// preventDefault marks the surface as a valid drop target.
			e.preventDefault();
			e.dataTransfer.dropEffect = 'copy';
		},
		[ interactive ]
	);

	const handleDrop = useCallback(
		( e ) => {
			if ( ! interactive || ! onDropNode || ! svgRef.current ) {
				return;
			}
			const shellName = e.dataTransfer.getData(
				'application/x-newspack-node'
			);
			if ( ! shellName ) {
				return;
			}
			e.preventDefault();
			// Project (clientX, clientY) → SVG-space via the current CTM.
			const pt = svgRef.current.createSVGPoint();
			pt.x = e.clientX;
			pt.y = e.clientY;
			const ctm = svgRef.current.getScreenCTM();
			if ( ! ctm ) {
				return;
			}
			const local = pt.matrixTransform( ctm.inverse() );
			onDropNode( { shellName, x: local.x, y: local.y } );
			// Blur the browser-left-active palette item so stale focus
			// doesn't intercept the next click (via ownerDocument).
			const doc = svgRef.current && svgRef.current.ownerDocument;
			const active = doc && doc.activeElement;
			if ( active && active.blur ) {
				active.blur();
			}
		},
		[ interactive, onDropNode ]
	);

	// SVG pixel size — used as the autofit minimum so a small graph in a
	// small canvas stays at native zoom (instead of using a hardcoded 1280
	// fallback that makes nodes appear shrunken in narrow panels).
	const canvasSize = () => {
		const el = svgRef.current;
		if ( ! el ) {
			return null;
		}
		return { w: el.clientWidth, h: el.clientHeight };
	};

	// Track the canvas pixel size reactively (a ref read isn't) so the autofit and
	// the viewport cull recompute when the overlay panel is resized — otherwise the
	// cull keeps deciding against a stale canvas size until the next pan/zoom.
	const [ canvasPx, setCanvasPx ] = useState( { w: 0, h: 0 } );
	useEffect( () => {
		const el = svgRef.current;
		if ( ! el ) {
			return undefined;
		}
		const measure = () =>
			setCanvasPx( { w: el.clientWidth, h: el.clientHeight } );
		measure();
		if ( typeof window === 'undefined' || ! window.ResizeObserver ) {
			return undefined;
		}
		const ro = new window.ResizeObserver( measure );
		ro.observe( el );
		return () => ro.disconnect();
	}, [] );

	const defaultViewBox = useMemo(
		() => tightViewBoxFor( displayNodes, canvasPx.w ? canvasPx : null ),
		[ displayNodes, canvasPx ]
	);
	const viewBox = viewport
		? `${ viewport.x } ${ viewport.y } ${ viewport.w } ${ viewport.h }`
		: defaultViewBox;
	const vb = viewport || parseViewBox( defaultViewBox );

	// Cull for the current viewport so a multi-thousand-node graph doesn't put
	// every card (and every label) in the DOM. Only nodes intersecting the viewBox
	// render; below a readable scale the cards drop to bare rects (LOD). Recomputed
	// on viewport / node-position / canvas-size changes, not on hover.
	const { visibleIds, showDetail, scale, region, visibleRegion } = useMemo(
		() =>
			viewportCull( displayNodes, vb, canvasPx, {
				nodeW: NODE_W,
				nodeH: NODE_H,
				overscan: NODE_OVERSCAN,
			} ),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ viewport, defaultViewBox, displayNodes, canvasPx ]
	);
	// Minimum node size in WORLD units to keep each card >= MIN_NODE_PX on screen.
	// scale is px/world-unit; 0 (no floor) when unmeasured (scale === Infinity).
	const minNodeWorld =
		Number.isFinite( scale ) && scale > 0 ? MIN_NODE_PX / scale : 0;
	const nodeRenderW = Math.max( NODE_W, minNodeWorld );
	const nodeRenderH = Math.max( NODE_H, minNodeWorld );
	// Freeze the autofit on first render so node drags don't live-shift
	// the whole canvas (viewport=null otherwise re-fits every render).
	// Keyed on nodes.length, reading nodesRef (not displayNodes) so an
	// in-flight drag doesn't commit and identity churn doesn't re-fit.
	useEffect( () => {
		const currentNodes = nodesRef.current;
		if ( ! viewport && currentNodes.length > 0 ) {
			setViewport(
				parseViewBox( tightViewBoxFor( currentNodes, canvasSize() ) )
			);
		}
	}, [ viewport, nodes.length, setViewport ] );

	// hoveredId is lifted so the Inspector can drive the same highlight.
	const setHovered = ( id ) => {
		if ( onHover ) {
			onHover( id );
		}
	};

	// Cursor-anchored wheel zoom; preventDefault stops page scroll.
	const handleWheel = ( e ) => {
		e.preventDefault();
		const svg = e.currentTarget;
		const world = screenToSvg( svg, e.clientX, e.clientY );
		const current = viewport || parseViewBox( defaultViewBox );
		const measured = canvasSize();
		// Unmeasured (first render / tests): fall back to the viewBox's own size
		// so zoom still scales by `factor` and keeps the current aspect.
		const cs =
			measured && measured.w && measured.h
				? measured
				: { w: current.w, h: current.h };
		const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
		// Work in scale-space (px per world unit) so the limits are ABSOLUTE: a
		// giant graph can still be zoomed in to read. The displayed scale under
		// preserveAspectRatio="meet" is the smaller of the width/height fits.
		const baseVb = parseViewBox( defaultViewBox );
		const fitScale = Math.min( cs.w / baseVb.w, cs.h / baseVb.h );
		const curScale = Math.min( cs.w / current.w, cs.h / current.h );
		const minScale = fitScale * ZOOM_MIN;
		const maxScale = Math.max( fitScale, SCALE_MAX );
		const nextScale = Math.max(
			minScale,
			Math.min( maxScale, curScale / factor )
		);
		// Zoomed regions take the CANVAS aspect so they fill the panel instead of
		// letterboxing a tall-narrow graph into an unreadable thin strip.
		const nextW = cs.w / nextScale;
		const nextH = cs.h / nextScale;
		// Anchor on the cursor's SCREEN fraction (of the canvas), not its world
		// fraction within the viewBox. Under a letterboxed (tall-narrow) autofit
		// the two diverge wildly — the whole graph renders as a thin strip, so a
		// world-fraction anchor flings it to the edge on the first zoom. The new
		// viewBox is canvas-aspect, so screen fraction maps back linearly.
		const rect = svg.getBoundingClientRect();
		const fracX = rect.width ? ( e.clientX - rect.left ) / rect.width : 0.5;
		const fracY = rect.height
			? ( e.clientY - rect.top ) / rect.height
			: 0.5;
		setViewport( {
			x: world.x - fracX * nextW,
			y: world.y - fracY * nextH,
			w: nextW,
			h: nextH,
		} );
	};

	// Attach the wheel zoom NON-PASSIVELY so preventDefault() actually stops the
	// page scrolling behind the canvas. React's onWheel is passive — Safari honors
	// that and scrolls the page; Chrome/FF log "Unable to preventDefault inside
	// passive event listener". A ref holds the latest closure so we attach once.
	const handleWheelRef = useRef( handleWheel );
	handleWheelRef.current = handleWheel;
	useEffect( () => {
		const el = svgRef.current;
		if ( ! el ) {
			return undefined;
		}
		const onWheel = ( e ) => handleWheelRef.current( e );
		el.addEventListener( 'wheel', onWheel, { passive: false } );
		return () => el.removeEventListener( 'wheel', onWheel );
	}, [] );

	// Arrow keys pan the viewport (hold to repeat; shift pans faster). A `null`
	// viewport materializes from the autofit viewBox so panning works from the
	// default fit too. document-level to match the Delete handler, skipped while
	// typing in a form field; `setViewport` is a no-op when the parent owns no
	// viewport. A ref feeds the latest viewport so the listener binds once.
	const panStateRef = useRef( { viewport, defaultViewBox } );
	panStateRef.current = { viewport, defaultViewBox };
	useEffect( () => {
		const onKey = ( e ) => {
			const dir = ARROW_PAN[ e.key ];
			if ( ! dir ) {
				return;
			}
			// Only pan (and swallow the arrow) while the canvas is hovered, so the
			// overlay doesn't steal the host page's arrow scrolling.
			if ( ! canvasHoverRef.current ) {
				return;
			}
			const tag = e.target && e.target.tagName;
			if (
				tag === 'INPUT' ||
				tag === 'TEXTAREA' ||
				tag === 'SELECT' ||
				( e.target && e.target.isContentEditable )
			) {
				return;
			}
			e.preventDefault();
			const cur =
				panStateRef.current.viewport ||
				parseViewBox( panStateRef.current.defaultViewBox );
			const step = e.shiftKey ? PAN_STEP_FAST : PAN_STEP;
			setViewport( {
				...cur,
				x: cur.x + dir[ 0 ] * cur.w * step,
				y: cur.y + dir[ 1 ] * cur.h * step,
			} );
		};
		document.addEventListener( 'keydown', onKey );
		return () => document.removeEventListener( 'keydown', onKey );
	}, [ setViewport ] );

	// Pan on background drag (nodes stopPropagation); a non-drag click
	// becomes deselect/autofit.
	const handleBgPointerDown = ( e ) => {
		if ( e.button !== 0 ) {
			return;
		}
		const svg = e.currentTarget;
		svg.setPointerCapture( e.pointerId );
		const current = viewport || parseViewBox( defaultViewBox );
		const rect = svg.getBoundingClientRect();
		panRef.current = {
			startClient: { x: e.clientX, y: e.clientY },
			startVb: current,
			rect,
			dragged: false,
		};
	};
	const handleBgPointerMove = ( e ) => {
		if ( ! panRef.current ) {
			return;
		}
		const p = panRef.current;
		const dxScreen = e.clientX - p.startClient.x;
		const dyScreen = e.clientY - p.startClient.y;
		if (
			! p.dragged &&
			Math.abs( dxScreen ) <= DRAG_THRESHOLD &&
			Math.abs( dyScreen ) <= DRAG_THRESHOLD
		) {
			return;
		}
		p.dragged = true;
		// Read the actual rendered scale (min rect/vb) so pan matches cursor.
		const panScale = Math.min(
			p.rect.width / p.startVb.w,
			p.rect.height / p.startVb.h
		);
		const worldDx = dxScreen / panScale;
		const worldDy = dyScreen / panScale;
		setViewport( {
			x: p.startVb.x - worldDx,
			y: p.startVb.y - worldDy,
			w: p.startVb.w,
			h: p.startVb.h,
		} );
	};
	const handleBgPointerUp = ( e ) => {
		if ( ! panRef.current ) {
			return;
		}
		try {
			e.currentTarget.releasePointerCapture( e.pointerId );
		} catch ( _err ) {
			// Pointer capture may already be released; ignore.
		}
		const wasDragged = panRef.current.dragged;
		panRef.current = null;
		if ( ! wasDragged ) {
			// Autofit-only mode: a background click just re-fits, leaving the
			// transcript + inspector untouched.
			if ( backgroundClickAutofitsOnly ) {
				setViewport(
					parseViewBox(
						tightViewBoxFor( displayNodes, canvasSize() )
					)
				);
				return;
			}
			// Parent consumer gets first refusal (e.g. dismiss the prompt).
			if ( onBackgroundClickConsumed && onBackgroundClickConsumed() ) {
				return;
			}
			// First click deselects if anything is selected; else autofit.
			if ( selectedId || selectedEdge ) {
				if ( onDeselect ) {
					onDeselect();
				}
			} else {
				setViewport(
					parseViewBox(
						tightViewBoxFor( displayNodes, canvasSize() )
					)
				);
			}
		}
	};

	const beginDrag = ( e, node ) => {
		// Left-button only.
		if ( e.button !== 0 ) {
			return;
		}
		// Listen to both pointerdown + mousedown (Safari swallows pointerdown
		// after an HTML5 drop); the guard dedupes the normal paired-fire case.
		if ( beginDragGuardRef.current ) {
			// Stop the deduped duplicate so it doesn't bubble and start a pan.
			e.stopPropagation();
			return;
		}
		beginDragGuardRef.current = true;
		// Reset next tick: after the paired event, before the next interaction.
		setTimeout( () => {
			beginDragGuardRef.current = false;
		}, 50 );
		e.stopPropagation();
		draggedRef.current = false;
		const svg = e.currentTarget.ownerSVGElement;
		const startSvg = screenToSvg( svg, e.clientX, e.clientY );
		setDrag( {
			nodeId: node.id,
			startSvg,
			originalPos: node.position,
			currentPos: node.position,
		} );
		e.currentTarget.setPointerCapture( e.pointerId );
	};

	const updateDrag = ( e ) => {
		if ( ! drag ) {
			return;
		}
		const svg = e.currentTarget.ownerSVGElement;
		const cur = screenToSvg( svg, e.clientX, e.clientY );
		const dx = cur.x - drag.startSvg.x;
		const dy = cur.y - drag.startSvg.y;
		if (
			Math.abs( dx ) > DRAG_THRESHOLD ||
			Math.abs( dy ) > DRAG_THRESHOLD
		) {
			draggedRef.current = true;
		}
		setDrag( {
			...drag,
			currentPos: {
				x: drag.originalPos.x + dx,
				y: drag.originalPos.y + dy,
			},
		} );
	};

	const endDrag = ( e ) => {
		if ( ! drag ) {
			return;
		}
		try {
			e.currentTarget.releasePointerCapture( e.pointerId );
		} catch ( _err ) {
			// Pointer capture may already be released; ignore.
		}
		if ( draggedRef.current && onPositionChange ) {
			// Snap to half-steps of the auto-layout grid (anchored at
			// X_PAD/Y_PAD); negatives are allowed.
			const halfX = X_STEP / 2;
			const halfY = Y_STEP / 2;
			const xi = Math.round( ( drag.currentPos.x - X_PAD ) / halfX );
			const yi = Math.round( ( drag.currentPos.y - Y_PAD ) / halfY );
			onPositionChange( drag.nodeId, {
				x: X_PAD + xi * halfX,
				y: Y_PAD + yi * halfY,
			} );
		}
		setDrag( null );
		// Reset the click-suppress flag next microtask so the click after
		// pointerup still sees the "we just dragged" signal.
		const wasDragged = draggedRef.current;
		setTimeout( () => {
			draggedRef.current = wasDragged ? true : false;
		}, 0 );
	};

	// One node card. Extracted for readability; all visible cards render into the
	// single nodes group (which carries the bloom filter when zoomed in for text).
	const renderNode = ( n ) => {
		const isSelected = n.id === selectedId;
		const isHovered = n.id === hoveredId;
		const isFaded = hoveredId && ! isHovered;
		const isDragging = drag && drag.nodeId === n.id;
		return (
			<g
				key={ n.id }
				className={ `topology-node${
					isSelected ? ' is-selected' : ''
				}${ isHovered ? ' is-hovered' : '' }${
					isFaded ? ' is-faded' : ''
				}${ isDragging ? ' is-dragging' : '' }${
					showDetail ? '' : ' is-static'
				}` }
				transform={ `translate(${ n.position.x },${ n.position.y })` }
				onClick={ ( ev ) => {
					ev.stopPropagation();
					// Suppress selection after a real drag.
					if ( draggedRef.current ) {
						draggedRef.current = false;
						return;
					}
					if ( onSelect ) {
						onSelect( n.id );
					}
				} }
				onPointerDown={ ( ev ) => beginDrag( ev, n ) }
				onMouseDown={ ( ev ) => beginDrag( ev, n ) }
				onPointerMove={ updateDrag }
				onPointerUp={ endDrag }
				onPointerCancel={ endDrag }
				onMouseEnter={ () => setHovered( n.id ) }
				onMouseLeave={ () => setHovered( null ) }
			>
				<rect
					className="topology-node__shadow"
					x={ 3 }
					y={ 3 }
					width={ NODE_W }
					height={ NODE_H }
				/>
				<rect
					className="topology-node__bg"
					width={ nodeRenderW }
					height={ nodeRenderH }
				/>
				{ /* Labels/sparkline/ports only when zoomed in enough to read. */ }
				{ showDetail && (
					<>
						{ /* Card-clipped label layer: a long id/type can't write
						     past the card edge (so it can't bloom outside it either).
						     Ports sit ON the edge, so they stay outside the clip. */ }
						<g clipPath="url(#topology-node-clip)">
							{ /* Title band behind the type/id; transparent by
							     default, filled per-skin (Newspack shades it). */ }
							<rect
								className="topology-node__header"
								width={ NODE_W }
								height={ 22 }
							/>
							<line
								className="topology-node__divider"
								x1={ 0 }
								y1={ 22 }
								x2={ NODE_W }
								y2={ 22 }
							/>
							<text
								className="topology-node__type"
								x={ 11 }
								y={ 15 }
							>
								{ n.class }
							</text>
							<circle
								className="topology-node__led"
								cx={ NODE_W - 12 }
								cy={ 13 }
								r={ 3.5 }
							/>
							<text
								className="topology-node__id"
								x={ 11 }
								y={ 44 }
							>
								{ n.id }
							</text>
							{ /* Per-node rate sparkline; hidden under two samples. */ }
							{ rateRef &&
								( () => {
									const history = rateRef.current.get(
										n.id
									)?.history;
									const path = sparklinePath( history );
									if ( ! path ) {
										return null;
									}
									return (
										<path
											className="topology-node__spark"
											d={ path }
										/>
									);
								} )() }
							{ /* Per-node rate, bottom-left; quiet nodes show nothing. */ }
							{ rateRef && (
								<text
									className="topology-node__rate"
									x={ 11 }
									y={ 76 }
								>
									{ formatNodeRate(
										rateRef.current.get( n.id )?.rate
									) }
								</text>
							) }
							<text
								className="topology-node__counter"
								x={ NODE_W - 11 }
								y={ 76 }
								textAnchor="end"
							>
								{ compactCount( n.count ) }
							</text>
						</g>
						{ ( n.accepts_fill ??
							classCatalog[ n.class ]?.accepts_fill ??
							true ) && (
							<circle
								className={ `topology-port topology-port--in${
									wireDrag && wireDrag.hoveredId === n.id
										? ' is-snap-target'
										: ''
								}` }
								cx={ 0 }
								cy={ NODE_H / 2 }
								r={ PORT_R }
							/>
						) }
						{ ( n.has_target ??
							classCatalog[ n.class ]?.has_target ??
							true ) && (
							<circle
								className={ `topology-port topology-port--out${
									editMode ? ' is-edit' : ''
								}${
									interactive && onConnect
										? ' is-wire-source'
										: ''
								}` }
								cx={ NODE_W }
								cy={ NODE_H / 2 }
								r={ PORT_R }
								onPointerDown={ ( e ) =>
									handlePortPointerDown( n.id, e )
								}
								onMouseDown={ ( e ) =>
									handlePortPointerDown( n.id, e )
								}
							/>
						) }
					</>
				) }
			</g>
		);
	};

	return (
		<svg
			ref={ svgRef }
			className="topology-canvas-svg"
			viewBox={ viewBox }
			preserveAspectRatio="xMidYMid meet"
			onPointerDown={ handleBgPointerDown }
			onPointerMove={ handleBgPointerMove }
			onPointerUp={ handleBgPointerUp }
			onPointerCancel={ handleBgPointerUp }
			onPointerEnter={ () => {
				canvasHoverRef.current = true;
			} }
			onPointerLeave={ () => {
				canvasHoverRef.current = false;
			} }
			onDragOver={ handleDragOver }
			onDrop={ handleDrop }
		>
			<defs>
				{ /* Half-step grid offset so intersections fall on node centers. */ }
				<pattern
					id="topology-grid"
					x={ X_PAD + NODE_W / 2 }
					y={ Y_PAD + NODE_H / 2 }
					width={ X_STEP / 2 }
					height={ Y_STEP / 2 }
					patternUnits="userSpaceOnUse"
				>
					<path
						d={ `M ${ X_STEP / 2 } 0 L 0 0 0 ${ Y_STEP / 2 }` }
						className="topology-grid-line"
					/>
				</pattern>
				<marker
					id="topology-arrow"
					viewBox="0 0 10 10"
					refX="9"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto"
				>
					<path
						d="M0,0 L10,5 L0,10 z"
						className="topology-arrow-head"
					/>
				</marker>
				<marker
					id="topology-arrow-active"
					viewBox="0 0 10 10"
					refX="9"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto"
				>
					<path
						d="M0,0 L10,5 L0,10 z"
						className="topology-arrow-head topology-arrow-head--active"
					/>
				</marker>
				{ /* Clip each card's label layer to the card rect so a long id /
				     type can't write past the edge (nor bloom past it). userSpace
				     coords are the card-local frame under the node's transform. */ }
				<clipPath
					id="topology-node-clip"
					clipPathUnits="userSpaceOnUse"
				>
					{ /* rx/ry round the label-clip to the card radius so a shaded title band's top corners follow the rounding (Newspack); harmless for square-card skins. */ }
					<rect
						x={ 0 }
						y={ 0 }
						width={ NODE_W }
						height={ NODE_H }
						rx={ 7 }
						ry={ 7 }
					/>
				</clipPath>
				{ /* Group bloom: ONE blur pass per group (vs a drop-shadow per
				     glyph), blurring real pixels so each element keeps its color and
				     the cards + names bloom together. The blur is `screen`-blended
				     OVER the source (not feMerge'd UNDER it) so the glow composites
				     ADDITIVELY — interior glyph/name/LED glow shows through the
				     opaque card instead of being painted over by the sharp card on
				     top (which is what hid it). Referenced by the --bloom groups via
				     `filter:url()` in the CRT and Neo-Tokyo themes only.
				     The region is pinned to the strict viewport (userSpaceOnUse) so
				     the blur buffer is exactly the visible rect — never the full
				     group bbox (which spans the overscan ring) nor a degenerate
				     near-zero-height bbox (a row of horizontal edges). stdDeviation
				     is world units ÷ scale, holding a constant on-screen glow. */ }
				<filter
					id="topology-bloom-crt"
					filterUnits="userSpaceOnUse"
					x={ visibleRegion.x }
					y={ visibleRegion.y }
					width={ visibleRegion.w }
					height={ visibleRegion.h }
					colorInterpolationFilters="sRGB"
				>
					<feGaussianBlur
						in="SourceGraphic"
						stdDeviation={ bloomStdDev(
							BLOOM_STDDEV_PX.crt,
							scale
						) }
						result="bloom"
					/>
					<feBlend mode="screen" in="SourceGraphic" in2="bloom" />
				</filter>
				<filter
					id="topology-bloom-neo"
					filterUnits="userSpaceOnUse"
					x={ visibleRegion.x }
					y={ visibleRegion.y }
					width={ visibleRegion.w }
					height={ visibleRegion.h }
					colorInterpolationFilters="sRGB"
				>
					<feGaussianBlur
						in="SourceGraphic"
						stdDeviation={ bloomStdDev(
							BLOOM_STDDEV_PX.neo,
							scale
						) }
						result="bloom"
					/>
					<feBlend mode="screen" in="SourceGraphic" in2="bloom" />
				</filter>
			</defs>

			{ /* Large origin-centered fill so pan/zoom needs no re-render. */ }
			<rect
				x="-4000"
				y="-4000"
				width="8000"
				height="8000"
				fill="url(#topology-grid)"
				pointerEvents="none"
			/>

			{ showDetail &&
				( () => {
					// Bloom only full (both-endpoints-visible) connections; a stub
					// — an edge whose far endpoint is off-screen — renders in the
					// plain group so its glow never bleeds from off-screen.
					const bloomEdges = [];
					const plainEdges = [];
					edges.forEach( ( e, i ) => {
						const a = nodeById.get( e.from );
						const b = nodeById.get( e.to );
						if ( ! a || ! b ) {
							return;
						}
						// Cull only edges with BOTH endpoints off-screen; one
						// visible endpoint anchors the edge on-screen.
						if ( ! isEdgeVisible( e.from, e.to, visibleIds ) ) {
							return;
						}
						// Animate the flow ONLY where data actually moved this dump:
						// both endpoints' counters incremented since the last
						// dump_metadata (rate > 0). Idle connections stay static, so
						// the per-frame bloom re-raster is paid only for live paths.
						const fromRate =
							rateRef?.current?.get( e.from )?.rate ?? 0;
						const toRate = rateRef?.current?.get( e.to )?.rate ?? 0;
						const flowing = fromRate > 0 && toRate > 0;
						const hoverTouches =
							hoveredId === e.from || hoveredId === e.to;
						const selectTouches =
							! hoveredId &&
							( selectedId === e.from || selectedId === e.to );
						// Hover highlights + dims the rest; selection highlights
						// without dimming so surrounding context stays visible.
						const touches = hoverTouches || selectTouches;
						const dimmed = hoveredId && ! hoverTouches;
						const isEdgeSelected =
							selectedEdge &&
							selectedEdge.from === e.from &&
							selectedEdge.to === e.to;
						// One endpoint off-screen: straight stub from the visible
						// port toward the off-screen port, clipped to the viewport
						// (no giant bezier to the off-screen peer, no arrowhead).
						// Both visible → the normal node-to-node bezier.
						const fromVis = visibleIds.has( e.from );
						const toVis = visibleIds.has( e.to );
						let d;
						let stub = false;
						if ( fromVis && toVis ) {
							d = edgePath( a, b );
						} else {
							const visP = fromVis
								? {
										x: a.position.x + NODE_W,
										y: a.position.y + NODE_H / 2,
								  }
								: {
										x: b.position.x,
										y: b.position.y + NODE_H / 2,
								  };
							const offP = fromVis
								? {
										x: b.position.x,
										y: b.position.y + NODE_H / 2,
								  }
								: {
										x: a.position.x + NODE_W,
										y: a.position.y + NODE_H / 2,
								  };
							const exit = clipSegmentExit(
								visP.x,
								visP.y,
								offP.x,
								offP.y,
								region
							);
							d = `M ${ visP.x },${ visP.y } L ${ exit.x },${ exit.y }`;
							stub = true;
						}
						const el = (
							<g key={ `edge-${ i }-${ e.from }-${ e.to }` }>
								{ e.registration && e.event && (
									<title>{ e.event }</title>
								) }
								<path
									className={ `topology-edge topology-edge--active${
										flowing ? ' topology-edge--flowing' : ''
									}${ touches ? ' is-touched' : '' }${
										dimmed ? ' is-dimmed' : ''
									}${ isEdgeSelected ? ' is-selected' : '' }${
										e.virtual ? ' is-virtual' : ''
									}${
										e.registration ? ' is-registration' : ''
									}` }
									d={ d }
									markerEnd={
										stub
											? undefined
											: 'url(#topology-arrow-active)'
									}
								/>
								{ /* Fat hit-target, edit mode only; skip virtual + registration edges. */ }
								{ editMode &&
									onSelectEdge &&
									! e.virtual &&
									! e.registration && (
										<path
											className="topology-edge-hit"
											d={ d }
											onMouseDown={ ( ev ) => {
												ev.stopPropagation();
												onSelectEdge( {
													from: e.from,
													to: e.to,
												} );
											} }
											onPointerDown={ ( ev ) =>
												ev.stopPropagation()
											}
										/>
									) }
							</g>
						);
						( stub ? plainEdges : bloomEdges ).push( el );
					} );
					// Too many on-screen edges → drop the per-frame flow animation
					// so the raster threads aren't pegged repainting hundreds of
					// dashed paths every frame.
					const still =
						bloomEdges.length + plainEdges.length > EDGE_FLOW_MAX
							? ' topology-edges--still'
							: '';
					return (
						<>
							<g
								className={ `topology-edges topology-edges--bloom${ still }` }
							>
								{ bloomEdges }
							</g>
							<g className={ `topology-edges${ still }` }>
								{ plainEdges }
							</g>
						</>
					);
				} )() }

			{ /* One stable nodes group — no per-frame reparenting (so a drag never
			     remounts a card and drops pointer capture). It carries the bloom
			     filter when zoomed in for text; the viewport-pinned filter region
			     keeps the blur bounded to the visible rect. */ }
			<g
				className={ `topology-nodes${
					showDetail ? ' topology-nodes--bloom' : ''
				}` }
			>
				{ displayNodes.map( ( n ) => {
					// Cull off-viewport nodes (always render the one being dragged).
					if (
						! visibleIds.has( n.id ) &&
						! ( drag && drag.nodeId === n.id )
					) {
						return null;
					}
					return renderNode( n );
				} ) }
			</g>
			{ wireDrag && (
				<g className="topology-wire-drag">
					<line
						x1={ wireDrag.x1 }
						y1={ wireDrag.y1 }
						x2={ wireDrag.x2 }
						y2={ wireDrag.y2 }
						className="topology-wire-drag__line"
					/>
				</g>
			) }
		</svg>
	);
}
