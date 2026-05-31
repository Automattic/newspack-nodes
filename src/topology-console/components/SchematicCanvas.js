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

import {
	autoLayout,
	placeNewNode,
	X_PAD,
	X_STEP,
	Y_PAD,
	Y_STEP,
} from '../utils/autoLayout';
import { viewportCull, isEdgeVisible } from '../utils/viewportCull';

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
// Below this scale, edges are unreadable spaghetti and just thousands of paths to
// paint — skip the whole edge layer so a multi-thousand-node OVERVIEW stays light
// (an LOD step below the per-node detail cull). Edges return as you zoom in.
const EDGE_MIN_SCALE = 0.05;
// Floor a node's on-screen size to this many CSS px so a card never shrinks to a
// sub-pixel rect that some browsers (Firefox) drop entirely. At a tiny scale the
// bare rect is enlarged in world units so it still paints ~2px.
const MIN_NODE_PX = 2;
// Render this fraction of a viewport of off-screen nodes on each side so panning
// scrolls smoothly and a narrow column doesn't blink out when nudged sideways.
const NODE_OVERSCAN = 0.5;

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
	// shell_name → schema; drives port visibility (accepts_fill/has_target).
	classCatalog = {},
	// One-shot persistence callback. When defined and `positionOverrides`
	// is empty, the canvas ships autoLayout's positions up so the parent
	// can save them. The receiving hook is idempotent (it no-ops if state
	// is already populated or the user has touched anything).
	onSeedLayout = null,
} ) {
	const edges = useMemo( () => parsed?.edges ?? [], [ parsed ] );
	// Positions: a single autoLayout pass places the INITIAL graph (no pins yet);
	// after that, a pinned node keeps its override and a newly-appeared node gets a
	// cheap placeNewNode spot near its connection. autoLayout never re-runs on a
	// metadata / connection change, so a placed node never re-flows.
	const nodePositions = useMemo( () => {
		const overrides = positionOverrides || {};
		const parsedNodes = parsed?.nodes ?? [];
		if ( Object.keys( overrides ).length === 0 ) {
			const out = {};
			for ( const n of autoLayout( parsed ).nodes ) {
				out[ n.id ] = n.position;
			}
			return out;
		}
		const out = { ...overrides };
		for ( const n of parsedNodes ) {
			if ( ! out[ n.id ] ) {
				out[ n.id ] = placeNewNode( n.id, parsed, out );
			}
		}
		return out;
	}, [ parsed, positionOverrides ] );
	const nodes = useMemo(
		() =>
			( parsed?.nodes ?? [] ).map( ( n ) => ( {
				...n,
				position: nodePositions[ n.id ],
			} ) ),
		[ parsed, nodePositions ]
	);

	// Mirror of `nodes` for the freeze effect (keyed on length, reads identity).
	const nodesRef = useRef( nodes );
	nodesRef.current = nodes;

	// Ship the computed positions up to the parent's layout store. The receiving
	// hook merges in a position only for nodes not yet pinned (never overwriting an
	// existing one), so this pins the initial autoLayout once and each newcomer's
	// placeNewNode spot once, then is a no-op.
	useEffect( () => {
		if ( ! onSeedLayout ) {
			return;
		}
		if ( Object.keys( nodePositions ).length === 0 ) {
			return;
		}
		onSeedLayout( nodePositions );
	}, [ nodePositions, onSeedLayout ] );

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
	const { visibleIds, showDetail, scale } = useMemo(
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
		const fracX = ( world.x - current.x ) / current.w;
		const fracY = ( world.y - current.y ) / current.h;
		setViewport( {
			x: world.x - fracX * nextW,
			y: world.y - fracY * nextH,
			w: nextW,
			h: nextH,
		} );
	};

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
			onWheel={ handleWheel }
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

			{ scale >= EDGE_MIN_SCALE && (
				<g className="topology-edges">
					{ edges.map( ( e, i ) => {
						const a = nodeById.get( e.from );
						const b = nodeById.get( e.to );
						if ( ! a || ! b ) {
							return null;
						}
						// Cull only edges with BOTH endpoints off-screen; one visible
						// endpoint is enough (it anchors the edge on-screen).
						if ( ! isEdgeVisible( e.from, e.to, visibleIds ) ) {
							return null;
						}
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
						const d = edgePath( a, b );
						return (
							<g key={ `edge-${ i }-${ e.from }-${ e.to }` }>
								<path
									className={ `topology-edge topology-edge--active${
										touches ? ' is-touched' : ''
									}${ dimmed ? ' is-dimmed' : '' }${
										isEdgeSelected ? ' is-selected' : ''
									}${ e.virtual ? ' is-virtual' : '' }${
										showDetail ? '' : ' is-static'
									}` }
									d={ d }
									markerEnd="url(#topology-arrow-active)"
								/>
								{ /* Fat hit-target, edit mode only; skip virtual edges. */ }
								{ editMode && onSelectEdge && ! e.virtual && (
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
					} ) }
				</g>
			) }

			<g className="topology-nodes">
				{ displayNodes.map( ( n ) => {
					// Cull off-viewport nodes (always render the one being dragged).
					if (
						! visibleIds.has( n.id ) &&
						! ( drag && drag.nodeId === n.id )
					) {
						return null;
					}
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
											const path =
												sparklinePath( history );
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
												rateRef.current.get( n.id )
													?.rate
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
									{ ( n.accepts_fill ??
										classCatalog[ n.class ]?.accepts_fill ??
										true ) && (
										<circle
											className={ `topology-port topology-port--in${
												wireDrag &&
												wireDrag.hoveredId === n.id
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
