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
import { maxInsetBeforeLOD } from '../utils/viewportResize';
import { deltaFromAutofit, viewportFromDelta } from '../utils/autofitDelta';
import { hullPath } from '../utils/hullPath';

// Exported so the palette drag ghost can render the same node-card geometry.
export const NODE_W = 196;
export const NODE_H = 84;
export const PORT_R = 4.5;
// Movement (SVG units) before a pointer-down counts as a drag, not a click.
const DRAG_THRESHOLD = 3;

// Convert pointer (viewport) coords to SVG coords via the CTM scale.
function screenToSvg( svg, clientX, clientY ) {
	// jsdom has no SVG geometry; fall back to raw coords (deltas still hold).
	if ( ! svg || ! svg.createSVGPoint ) {
		return { x: clientX, y: clientY };
	}
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

// Fallback canvas size before measurement (jsdom / first render).
const AUTOFIT_FALLBACK_W = 1280;
const AUTOFIT_FALLBACK_H = 720;
// Fraction of the binding dimension the graph fills (fit-all ~90%).
const AUTOFIT_FILL = 0.9;
// Cap on autofit zoom-IN (px/world) so a tiny graph doesn't balloon.
const AUTOFIT_MAX_SCALE = 2;
// World-unit bbox of the nodes; null for empty, || NODE_* guards a zero span.
function nodesBBox( nodes ) {
	if ( ! nodes.length ) {
		return null;
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
	return {
		minX,
		minY,
		maxX,
		maxY,
		w: maxX - minX || NODE_W,
		h: maxY - minY || NODE_H,
	};
}

function tightViewBoxFor( nodes, canvasSize = null, bottomInsetPx = 0 ) {
	const minW = canvasSize?.w || AUTOFIT_FALLBACK_W;
	const minH = canvasSize?.h || AUTOFIT_FALLBACK_H;
	const bbox = nodesBBox( nodes );
	if ( ! bbox ) {
		return `0 0 ${ minW } ${ minH }`;
	}
	// Usable height = canvas minus the bottom obstruction; graph fits above it.
	const usableH = Math.max( 1, minH - Math.max( 0, bottomInsetPx ) );
	// Scale to fill AUTOFIT_FILL of the binding dim, capped for tiny graphs.
	const scale = Math.min(
		AUTOFIT_MAX_SCALE,
		AUTOFIT_FILL * Math.min( minW / bbox.w, usableH / bbox.h )
	);
	const w = minW / scale;
	const h = minH / scale;
	const centerX = ( bbox.minX + bbox.maxX ) / 2;
	const centerY = ( bbox.minY + bbox.maxY ) / 2;
	const x = centerX - w / 2;
	// Center the bbox in the top usable band (else full-canvas center).
	const y = centerY - usableH / ( 2 * scale );
	return `${ x } ${ y } ${ w } ${ h }`;
}

// Wheel zoom step (multiplicative), cursor-anchored.
const ZOOM_STEP = 1.12;
// How far past the whole-graph fit you can zoom OUT.
const ZOOM_MIN = 0.25;
// Deepest zoom-IN as ABSOLUTE px/world so a giant graph stays card-readable.
const SCALE_MAX = 3;
// Floor on-screen node size (px) so a card never drops to a sub-pixel rect.
const MIN_NODE_PX = 2;
// Overscan fraction of off-screen nodes each side so panning stays smooth.
const NODE_OVERSCAN = 0.5;
// LOD scale below which cards drop to bare rects — MUST match detailScale.
const LOD_DETAIL_SCALE = 0.35;
// Floor a hair ABOVE the LOD threshold so rounding can't tip cards into LOD.
const LOD_FLOOR_SCALE = LOD_DETAIL_SCALE * 1.2;
// A near-covering transcript counts as "full": frame as if it were CLOSED.
const TRANSCRIPT_FULL_FRACTION = 0.9;

// Arrow-key pan: viewport fraction per keypress; shift pans faster.
const PAN_STEP = 0.08;
const PAN_STEP_FAST = 0.25;
const ARROW_PAN = {
	ArrowLeft: [ -1, 0 ],
	ArrowRight: [ 1, 0 ],
	ArrowUp: [ 0, -1 ],
	ArrowDown: [ 0, 1 ],
};

// Above this many on-screen edges, suppress the edge-flow anim (raster peg).
const EDGE_FLOW_MAX = 40;

// Bloom blur radius in SCREEN px (÷ scale each render for a constant glow).
const BLOOM_STDDEV_PX = { crt: 5, neo: 4 };
// stdDeviation (world units) for a screen-constant glow; 0 when unmeasured.
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

// A node is "idle" when its rate is below the display floor — dim it.
export function isIdleRate( rate ) {
	return ! rate || rate < 0.05;
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
	viewportDelta,
	onViewportChange,
	// interactive gates gestures; editMode gates only draft-only affordances.
	onConnect,
	interactive = true,
	editMode = false,
	selectedEdge = null,
	onSelectEdge,
	// Canvas px obstructed at the bottom (expanded REPL); autofit reserves it.
	bottomObstructionPx = 0,
	// shell_name → schema; drives port visibility (accepts_fill/has_target).
	classCatalog = {},
	// Ids live but NOT in the .tsl (runtime drift); painted via `is-drift`.
	driftIds = null,
	// One soft hull per include, at ANY depth: { include, nodeIds }.
	hulls = [],
	selectedHull = null,
	onSelectHull,
} ) {
	const edges = useMemo( () => parsed?.edges ?? [], [ parsed ] );
	const hullPaths = useMemo(
		() =>
			hulls
				.map( ( h ) => ( {
					include: h.include,
					d: hullPath(
						h.nodeIds
							.map( ( id ) => positionOverrides[ id ] )
							.filter( Boolean )
							.map( ( p ) => ( {
								x: p.x,
								y: p.y,
								w: NODE_W,
								h: NODE_H,
							} ) )
					),
				} ) )
				.filter( ( h ) => h.d ),
		[ hulls, positionOverrides ]
	);
	// Complete position map; render only positioned nodes (new ones lag).
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

	// Mirror of `nodes` for the freeze effect (keyed on length).
	const nodesRef = useRef( nodes );
	nodesRef.current = nodes;

	// Active-drag state; snap + commit happen on pointerup.
	const [ drag, setDrag ] = useState( null );
	// Hovered hull (highlight it, dim every non-member) + in-flight hull drag.
	const [ hoveredHull, setHoveredHull ] = useState( null );
	const [ hullDrag, setHullDrag ] = useState( null );
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
	// Autofit viewBox for current nodes+canvas; setViewport + freeze share it.
	const autofitBoxRef = useRef( null );
	// Parent viewport; null = autofit. Persisted as a delta from autofit.
	const setViewport = useCallback(
		( vp ) => {
			if ( ! onViewportChange ) {
				return;
			}
			const autofit = autofitBoxRef.current;
			onViewportChange(
				vp,
				vp && autofit ? deltaFromAutofit( vp, autofit ) : null
			);
		},
		[ onViewportChange ]
	);
	// Active pan drag on the empty canvas (stable start origin per move).
	const panRef = useRef( null );
	// Pointer-over gate: only steal arrow keys while the canvas is hovered.
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

	// Window-level wire-drag listeners; useCallback keeps closures fresh.
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
			// Snap to nearest IN port within PORT_HIT_R (never the source).
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
				// Stop the deduped duplicate; don't also start a node drag.
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
			// Window listeners (not SVG capture): survive Safari post-drop.
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

	// SVG pixel size as the autofit minimum so a small graph stays native zoom.
	const canvasSize = () => {
		const el = svgRef.current;
		if ( ! el ) {
			return null;
		}
		return { w: el.clientWidth, h: el.clientHeight };
	};

	// Track canvas px reactively so autofit + cull recompute on panel resize.
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
		() =>
			tightViewBoxFor(
				displayNodes,
				canvasPx.w ? canvasPx : null,
				bottomObstructionPx
			),
		[ displayNodes, canvasPx, bottomObstructionPx ]
	);
	const viewBox = viewport
		? `${ viewport.x } ${ viewport.y } ${ viewport.w } ${ viewport.h }`
		: defaultViewBox;
	const vb = viewport || parseViewBox( defaultViewBox );

	// Cull to the viewport so a huge graph doesn't put every card in the DOM.
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
	// Min node size in WORLD units to keep cards ≥ MIN_NODE_PX on screen.
	const minNodeWorld =
		Number.isFinite( scale ) && scale > 0 ? MIN_NODE_PX / scale : 0;
	const nodeRenderW = Math.max( NODE_W, minNodeWorld );
	const nodeRenderH = Math.max( NODE_H, minNodeWorld );
	// Cache autofit so persist + freeze share one basis.
	useEffect( () => {
		autofitBoxRef.current = parseViewBox(
			tightViewBoxFor(
				nodesRef.current,
				canvasSize(),
				bottomObstructionPx
			)
		);
	}, [ nodes, canvasPx, bottomObstructionPx ] );
	// Freeze autofit on first render so drags don't re-fit; apply stored delta.
	useEffect( () => {
		const currentNodes = nodesRef.current;
		const autofit = autofitBoxRef.current;
		if ( ! viewport && currentNodes.length > 0 && autofit ) {
			setViewport(
				viewportDelta
					? viewportFromDelta( viewportDelta, autofit )
					: autofit
			);
		}
	}, [
		viewport,
		viewportDelta,
		nodes.length,
		setViewport,
		bottomObstructionPx,
	] );

	// On resize, rewrite the viewport to track autofit without a full re-fit.
	const viewportRef = useRef( viewport );
	viewportRef.current = viewport;
	const prevSurfaceRef = useRef( null );
	useEffect( () => {
		const prev = prevSurfaceRef.current;
		if ( ! canvasPx.w || ! canvasPx.h ) {
			return; // unmeasured — keep the baseline for the first real measure
		}
		// Near-full transcript frames as CLOSED (inset 0); un-max reflows back.
		const effInset =
			bottomObstructionPx >= canvasPx.h * TRANSCRIPT_FULL_FRACTION
				? 0
				: bottomObstructionPx;
		const cur = { px: canvasPx, inset: effInset };
		if (
			! prev?.px?.w ||
			! prev?.px?.h ||
			( prev.px.w === canvasPx.w &&
				prev.px.h === canvasPx.h &&
				prev.inset === effInset )
		) {
			prevSurfaceRef.current = cur;
			return;
		}
		const vp = viewportRef.current;
		if ( ! vp ) {
			// Uncontrolled/not-frozen: the null-viewport path already re-fits.
			prevSurfaceRef.current = cur;
			return;
		}
		prevSurfaceRef.current = cur;
		// Committed nodes so a resize mid-drag fits the settled layout.
		const currentNodes = nodesRef.current;
		// Floor the reflow above LOD (band can't shrink past readable).
		const bboxH = nodesBBox( currentNodes )?.h ?? 0;
		const clampInset = ( inset, pxH ) =>
			Math.min(
				inset,
				maxInsetBeforeLOD( {
					canvasH: pxH,
					bboxH,
					detailScale: LOD_FLOOR_SCALE,
					fill: AUTOFIT_FILL,
				} )
			);
		// Re-derive the viewport against the new autofit, holding its delta.
		const oldBox = parseViewBox(
			tightViewBoxFor(
				currentNodes,
				prev.px,
				clampInset( prev.inset, prev.px.h )
			)
		);
		const newBox = parseViewBox(
			tightViewBoxFor(
				currentNodes,
				canvasPx,
				clampInset( effInset, canvasPx.h )
			)
		);
		const delta = deltaFromAutofit( vp, oldBox );
		const next = delta ? viewportFromDelta( delta, newBox ) : vp;
		if ( next !== vp ) {
			setViewport( next );
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ canvasPx, bottomObstructionPx ] );

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
		// Unmeasured: fall back to the viewBox size (keeps aspect + factor).
		const cs =
			measured && measured.w && measured.h
				? measured
				: { w: current.w, h: current.h };
		const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
		// Work in scale-space (px/world) so zoom limits are ABSOLUTE.
		const baseVb = parseViewBox( defaultViewBox );
		const fitScale = Math.min( cs.w / baseVb.w, cs.h / baseVb.h );
		const curScale = Math.min( cs.w / current.w, cs.h / current.h );
		const minScale = fitScale * ZOOM_MIN;
		const maxScale = Math.max( fitScale, SCALE_MAX );
		const nextScale = Math.max(
			minScale,
			Math.min( maxScale, curScale / factor )
		);
		// Zoomed regions take the CANVAS aspect (no letterboxing).
		const nextW = cs.w / nextScale;
		const nextH = cs.h / nextScale;
		// Anchor on cursor SCREEN fraction, not world (diverges on letterbox).
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

	// Attach wheel NON-PASSIVELY so preventDefault() stops the page scroll.
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

	// Arrow keys pan the viewport (document-level, skipped while typing).
	const panStateRef = useRef( { viewport, defaultViewBox } );
	panStateRef.current = { viewport, defaultViewBox };
	useEffect( () => {
		const onKey = ( e ) => {
			const dir = ARROW_PAN[ e.key ];
			if ( ! dir ) {
				return;
			}
			// Only pan (and swallow the arrow) while the canvas is hovered.
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

	// Pan on background drag; a non-drag click becomes deselect/autofit.
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
			// Clears any selection (a HULL counts too), else autofits.
			if ( selectedId || selectedEdge || selectedHull ) {
				if ( onDeselect ) {
					onDeselect();
				}
			} else {
				setViewport(
					parseViewBox(
						tightViewBoxFor(
							displayNodes,
							canvasSize(),
							bottomObstructionPx
						)
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
		// Listen to pointerdown + mousedown (Safari post-drop); guard dedupes.
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
			// Snap to half-steps of the layout grid (negatives allowed).
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
		// Reset click-suppress flag next microtask (click still sees drag).
		const wasDragged = draggedRef.current;
		setTimeout( () => {
			draggedRef.current = wasDragged ? true : false;
		}, 0 );
	};

	// Hovered hull's members; every other node dims so the group reads.
	const hoveredHullMembers = useMemo( () => {
		const hull = hulls.find( ( h ) => h.include === hoveredHull );
		return hull ? new Set( hull.nodeIds ) : null;
	}, [ hulls, hoveredHull ] );

	// A hull drag moves EVERY member by one delta; the cluster keeps shape.
	const beginHullDrag = ( ev, include ) => {
		const hull = hulls.find( ( h ) => h.include === include );
		if ( ! hull || ! onPositionChange ) {
			return;
		}
		ev.stopPropagation();
		const svg = ev.currentTarget.ownerSVGElement;
		const start = screenToSvg( svg, ev.clientX, ev.clientY );
		try {
			ev.currentTarget.setPointerCapture( ev.pointerId );
		} catch {
			// jsdom / no pointer capture — the drag still tracks.
		}
		setHullDrag( {
			include,
			start,
			origin: Object.fromEntries(
				hull.nodeIds
					.filter( ( id ) => positionOverrides[ id ] )
					.map( ( id ) => [ id, positionOverrides[ id ] ] )
			),
		} );
	};
	const updateHullDrag = ( ev ) => {
		if ( ! hullDrag ) {
			return;
		}
		const svg = ev.currentTarget.ownerSVGElement;
		const at = screenToSvg( svg, ev.clientX, ev.clientY );
		const dx = at.x - hullDrag.start.x;
		const dy = at.y - hullDrag.start.y;
		setHullDrag( ( d ) => ( d ? { ...d, dx, dy } : d ) );
	};
	const endHullDrag = () => {
		if ( ! hullDrag ) {
			return;
		}
		const { origin, dx = 0, dy = 0 } = hullDrag;
		for ( const [ id, pos ] of Object.entries( origin ) ) {
			onPositionChange( id, { x: pos.x + dx, y: pos.y + dy } );
		}
		setHullDrag( null );
	};

	// One node card; all visible cards share the single bloom-filtered group.
	const renderNode = ( n ) => {
		const isSelected = n.id === selectedId;
		const isHovered = n.id === hoveredId;
		const isFaded =
			( hoveredId && ! isHovered ) ||
			!! ( hoveredHullMembers && ! hoveredHullMembers.has( n.id ) );
		// Idle dim: LIVE mode only, and never inside the hovered hull.
		const isIdle =
			! editMode &&
			!! rateRef &&
			! hoveredHullMembers?.has( n.id ) &&
			isIdleRate( rateRef.current?.get( n.id )?.rate );
		const isDragging = drag && drag.nodeId === n.id;
		// Borrowed via `include`: locked, but its wiring stays editable.
		const isBorrowed = Array.isArray( n.origin ) && n.origin.length > 0;
		return (
			<g
				key={ n.id }
				className={ `topology-node${
					isSelected ? ' is-selected' : ''
				}${ isHovered ? ' is-hovered' : '' }${
					isFaded ? ' is-faded' : ''
				}${ isDragging ? ' is-dragging' : '' }${
					showDetail ? '' : ' is-static'
				}${ isIdle ? ' is-idle' : '' }${
					driftIds?.has( n.id ) ? ' is-drift' : ''
				}${ isBorrowed ? ' is-borrowed' : '' }` }
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
				{ /* Labels/ports/spark only when zoomed in. */ }
				{ showDetail && (
					<>
						{ /* Ports on the card edge, outside the clip. */ }
						<g clipPath="url(#topology-node-clip)">
							{ /* Title band behind type/id; per-skin fill. */ }
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
							{ /* ⏸ badge when a Consumer holds the cursor. */ }
							{ 'PAUSED' === n.polling && (
								<text
									className="topology-node__paused"
									x={ NODE_W - 24 }
									y={ 17 }
									textAnchor="end"
								>
									⏸
								</text>
							) }
							{ /* Borrowed via `include`: locked, but its wiring stays editable. */ }
							{ isBorrowed && (
								<text
									className="topology-node__lock"
									x={ NODE_W - 26 }
									y={ 15 }
								>
									🔒
								</text>
							) }
							<text
								className="topology-node__id"
								x={ 11 }
								y={ 44 }
							>
								{ n.id }
							</text>
							{ /* Rate sparkline; hidden under two samples. */ }
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
							{ /* Rate, bottom-left; quiet nodes show none. */ }
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
		>
			<defs>
				{ /* Half-step grid offset; intersections on node centers. */ }
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
				{ /* Clip the label layer to the card rect (userSpace). */ }
				<clipPath
					id="topology-node-clip"
					clipPathUnits="userSpaceOnUse"
				>
					{ /* rx/ry round the clip so title-band corners follow. */ }
					<rect
						x={ 0 }
						y={ 0 }
						width={ NODE_W }
						height={ NODE_H }
						rx={ 7 }
						ry={ 7 }
					/>
				</clipPath>
				{ /* Group bloom: one blur pass; region pinned to viewport. */ }
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

			{ /* One soft hull per include; overlapping where a node is shared. */ }
			<g className="topology-hulls">
				{ hullPaths.map( ( h, i ) => {
					const isDragging = hullDrag?.include === h.include;
					const offset = isDragging
						? `translate(${ hullDrag.dx || 0 },${
								hullDrag.dy || 0
						  })`
						: undefined;
					return (
						<path
							key={ h.include }
							className={ `topology-hull topology-hull--${
								i % 6
							}${
								hoveredHull === h.include ? ' is-hovered' : ''
							}${
								selectedHull === h.include ? ' is-selected' : ''
							}${ isDragging ? ' is-dragging' : '' }` }
							data-include={ h.include }
							d={ h.d }
							transform={ offset }
							onMouseEnter={ () => setHoveredHull( h.include ) }
							onMouseLeave={ () => setHoveredHull( null ) }
							onMouseDown={ () =>
								onSelectHull && onSelectHull( h.include )
							}
							onPointerDown={ ( ev ) =>
								beginHullDrag( ev, h.include )
							}
							onPointerMove={ updateHullDrag }
							onPointerUp={ endHullDrag }
							onPointerCancel={ endHullDrag }
						/>
					);
				} ) }
			</g>

			{ showDetail &&
				( () => {
					// Bloom only full edges; stub glow can't bleed off-screen.
					const bloomEdges = [];
					const plainEdges = [];
					edges.forEach( ( e, i ) => {
						const a = nodeById.get( e.from );
						const b = nodeById.get( e.to );
						if ( ! a || ! b ) {
							return;
						}
						// Cull only edges with BOTH endpoints off-screen.
						if ( ! isEdgeVisible( e.from, e.to, visibleIds ) ) {
							return;
						}
						// Animate flow where both counters moved (rate > 0).
						const fromRate =
							rateRef?.current?.get( e.from )?.rate ?? 0;
						const toRate = rateRef?.current?.get( e.to )?.rate ?? 0;
						const flowing = fromRate > 0 && toRate > 0;
						const hoverTouches =
							hoveredId === e.from || hoveredId === e.to;
						const selectTouches =
							! hoveredId &&
							( selectedId === e.from || selectedId === e.to );
						// Hover dims the rest; selection highlights, no dim.
						const touches = hoverTouches || selectTouches;
						// @longform A hovered hull lights the wires wholly inside
						// it, so an idle group doesn't read as bright boxes on
						// faded wire; every edge that leaves the hull dims.
						const lit =
							!! hoveredHullMembers &&
							hoveredHullMembers.has( e.from ) &&
							hoveredHullMembers.has( e.to );
						const inHoveredHull = ! hoveredHullMembers || lit;
						const dimmed =
							( hoveredId && ! hoverTouches ) || ! inHoveredHull;
						const isEdgeSelected =
							selectedEdge &&
							selectedEdge.from === e.from &&
							selectedEdge.to === e.to;
						// One endpoint off-screen: clip a stub to the viewport.
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
										lit ? ' is-lit' : ''
									}${ dimmed ? ' is-dimmed' : '' }${
										isEdgeSelected ? ' is-selected' : ''
									}${ e.virtual ? ' is-virtual' : '' }${
										e.registration ? ' is-registration' : ''
									}` }
									d={ d }
									markerEnd={
										stub
											? undefined
											: 'url(#topology-arrow-active)'
									}
								/>
								{ /* Edit-only hit-target; no virtual/reg. */ }
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
					// Too many on-screen edges → drop flow animation.
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

			{ /* One stable nodes group; a drag keeps pointer capture. */ }
			<g
				className={ `topology-nodes${
					showDetail ? ' topology-nodes--bloom' : ''
				}` }
			>
				{ displayNodes.map( ( n ) => {
					// Cull off-viewport nodes (always render the dragged one).
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
