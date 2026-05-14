/**
 * SchematicCanvas — raw SVG drafting-room canvas.
 *
 * Renders {nodes, edges} from parseLsOutput + autoLayout as an
 * engineering schematic: rectangular cards with a TYPE band header, an
 * id row, a status LED, a counter cell, input/output ports on the
 * sides, and orthogonal flow-dashed edges connecting them.
 *
 * Inspect-only in v1 — no drag, no palette drop. Click selects a node;
 * background click deselects. Layout is recomputed whenever the parsed
 * graph changes (node added/removed), but persists otherwise to keep
 * the canvas stable while counters tick.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';

import { autoLayout, X_STEP, Y_STEP, X_PAD, Y_PAD } from '../utils/autoLayout';
import { inferType } from '../utils/inferType';

const NODE_W = 196;
const NODE_H = 84;
const PORT_R = 4.5;
// Movement threshold (SVG units) before a pointer-down + drag is
// treated as a drag rather than a click. Anything under suppresses
// the drag and lets the click handler fire (node selection).
const DRAG_THRESHOLD = 3;

// Convert a viewport-coords pointer event to SVG-coords. SchematicCanvas
// uses viewBox so screen pixels and SVG units differ by the CTM scale;
// without this conversion the dragged node lags behind the cursor at
// any non-1:1 viewport size.
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
	// Cubic bezier — control points pulled horizontally from each
	// port so the curve eases in/out of the node. Orthogonal-elbow
	// routing made long vertical drops read as column separators
	// rather than directed edges; a smooth S-curve makes the source/
	// destination of each edge unmistakable even when several edges
	// converge on the same input port.
	const dx = Math.max( 60, Math.abs( x2 - x1 ) * 0.5 );
	const c1x = x1 + dx;
	const c2x = x2 - dx;
	return `M ${ x1 },${ y1 } C ${ c1x },${ y1 } ${ c2x },${ y2 } ${
		x2 - 6
	},${ y2 }`;
}

// Tight bbox of every node, padded so the graph isn't flush against
// the pane edges. The SVG's `preserveAspectRatio="xMidYMid meet"`
// centers this within the pane automatically. A floor on width/
// height caps the effective zoom — small graphs (2–3 nodes) used
// to autofit so aggressively that nodes looked giant; the floor
// expands the viewBox to AUTOFIT_MIN_W/H while keeping it centered
// on the bbox, so the graph stays at a reasonable cap and the pane
// has surrounding breathing room.
const CENTER_PAD = 80;
const AUTOFIT_MIN_W = 1280;
const AUTOFIT_MIN_H = 720;
function tightViewBoxFor( nodes ) {
	if ( ! nodes.length ) {
		return `0 0 ${ AUTOFIT_MIN_W } ${ AUTOFIT_MIN_H }`;
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
	const w = Math.max( AUTOFIT_MIN_W, bboxW );
	const h = Math.max( AUTOFIT_MIN_H, bboxH );
	// Center the (possibly enlarged) viewBox on the bbox center.
	const centerX = ( minX + maxX ) / 2;
	const centerY = ( minY + maxY ) / 2;
	const x = centerX - w / 2;
	const y = centerY - h / 2;
	return `${ x } ${ y } ${ w } ${ h }`;
}

// Wheel zoom step (multiplicative). Each notch in zooms or out by
// this factor; modifier-less wheel + cursor-anchored, so the world
// point under the cursor stays under the cursor.
const ZOOM_STEP = 1.12;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4.0;

// Parse the "x y w h" viewBox string back into an object for the
// pan/zoom math. Returns a safe fallback if the input is malformed.
function parseViewBox( str ) {
	const parts = str.split( /\s+/ ).map( Number );
	if ( parts.length !== 4 || parts.some( Number.isNaN ) ) {
		return { x: 0, y: 0, w: 1280, h: 720 };
	}
	return { x: parts[ 0 ], y: parts[ 1 ], w: parts[ 2 ], h: parts[ 3 ] };
}

// Sparkline area inside each node card — sits between the id row
// (text baseline at y=44) and the bottom rate/counter row (baseline
// at y=76). Auto-scaled to the window's max so a node that's
// recently bursty shows the shape regardless of absolute rate.
// Bottom edge at y=64 leaves a 4px breather before the rate/counter
// text starts climbing into view (the digits' top edge sits ~y=68).
const SPARK_X = 11;
const SPARK_Y = 48;
const SPARK_W = 174; // NODE_W (196) - 11 - 11
const SPARK_H = 16;
// Must equal TopologyConsole's RATE_HISTORY_MAX — the per-sample step
// is computed against this constant, not the current history length,
// so early ticks render right-aligned at the fixed step width instead
// of stretching to fill the plot. Keep these two in sync.
const SPARK_HISTORY_MAX = 60;
function sparklinePath( history ) {
	if ( ! history || history.length < 2 ) {
		return null;
	}
	const max = Math.max( ...history, 1e-9 );
	const step = SPARK_W / ( SPARK_HISTORY_MAX - 1 );
	// Right-align: the newest sample lands at the right edge of the
	// plot; earlier samples walk left at the fixed step. While history
	// is short, the curve only spans the rightmost portion of the
	// plot area — as samples accumulate it grows leftward until full.
	const startIdx = SPARK_HISTORY_MAX - history.length;
	return history
		.map( ( v, i ) => {
			// Defensive clamp: a negative sample (counter reset) would
			// otherwise plot below the box. TopologyConsole already
			// zeros these at source, but the clamp keeps the plot
			// well-formed even when an explicit zero ends up tiny-
			// negative from float math.
			const safeV = v > 0 ? v : 0;
			const x = SPARK_X + ( startIdx + i ) * step;
			const y = SPARK_Y + SPARK_H - ( safeV / max ) * SPARK_H;
			return `${ i === 0 ? 'M' : 'L' } ${ x.toFixed( 2 ) },${ y.toFixed(
				2
			) }`;
		} )
		.join( ' ' );
}

// Per-node rate format, lower-left of each node card. Shaved to two
// significant figures so the text fits inside the 196px node width
// without wrapping. Returns null below a threshold so dead nodes
// don't fill the canvas with "0 /s" noise.
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
	// rateVersion is consumed implicitly: a bump on the parent forces
	// SchematicCanvas to re-render, which re-reads rateRef.current in
	// the node render loop. Listed as a prop so React knows about it.
	// eslint-disable-next-line no-unused-vars
	rateVersion,
	viewport,
	onViewportChange,
	// Edit-mode affordances. `onDropNode` receives { shellName, x, y }
	// in SVG-space coordinates (post-viewBox projection). `onConnect`
	// fires when the user drags from a node's OUT port and releases on
	// another node's IN port. Both are no-ops in view mode — wired
	// through TopologyConsole based on the current `mode` state.
	onDropNode,
	onConnect,
	editMode = false,
} ) {
	// Apply user-pinned position overrides on top of the auto-layout
	// output. autoLayout still runs every poll (so newly-added nodes
	// get sensible defaults), but any node the user has dragged keeps
	// its dragged position — keyed by node name, so the override
	// survives substrate restarts that re-seed counters.
	const { nodes: laidOutNodes, edges } = useMemo(
		() => autoLayout( parsed ),
		[ parsed ]
	);
	const nodes = useMemo( () => {
		if ( ! positionOverrides ) {
			return laidOutNodes;
		}
		return laidOutNodes.map( ( n ) =>
			positionOverrides[ n.id ]
				? { ...n, position: positionOverrides[ n.id ] }
				: n
		);
	}, [ laidOutNodes, positionOverrides ] );

	// Active-drag state. Held in a single object so the dragged node
	// can render at its current (un-snapped) position while everyone
	// else stays put. Snap happens on pointerup; that's when the
	// committed override is sent back to the parent.
	const [ drag, setDrag ] = useState( null );
	// Whether the most recent pointer-down crossed the drag threshold.
	// Click handler reads this to suppress selection after a real drag.
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
	// Viewport is controlled by the parent — `null` means "no
	// override, autofit to the tight bbox". The parent persists this
	// to localStorage so reloads and topology switches preserve the
	// user's last view. A local setter wraps the prop-handler so
	// in-flight pan/zoom math stays terse.
	const setViewport = onViewportChange || ( () => {} );
	// Active pan drag on the empty canvas. Holds the starting viewport
	// (so each move re-reads from a stable origin) plus the starting
	// pointer position and whether the drag has crossed the threshold.
	const panRef = useRef( null );

	// SVG element ref used to project HTML drop coordinates (clientX/Y)
	// back into the canvas's viewBox coordinate system. Without the
	// projection, drops would land at raw pixel offsets that ignore
	// pan/zoom — perfectly wrong in any non-default viewport.
	const svgRef = useRef( null );

	// Wire-drag state. Null when idle; during a drag holds the source
	// node id, the SVG-space coords of both endpoints, and the id of
	// the IN port currently being snapped to (so the renderer can light
	// it up). Wire drags suppress the background pan handler (port
	// hits e.stopPropagation), so these two pointer paths don't fight.
	const [ wireDrag, setWireDrag ] = useState( null );

	// Port hit radius in SVG units. Generous enough to make snapping
	// feel responsive without overlapping adjacent nodes (NODE_W is
	// 196, so 24 is well under any node spacing).
	const PORT_HIT_R = 24;

	const handlePortPointerDown = useCallback(
		( nodeId, e ) => {
			if ( ! editMode || ! onConnect || e.button !== 0 ) {
				return;
			}
			e.stopPropagation();
			const svg = svgRef.current;
			if ( ! svg ) {
				return;
			}
			svg.setPointerCapture( e.pointerId );
			const node = nodes.find( ( n ) => n.id === nodeId );
			if ( ! node ) {
				return;
			}
			const x1 = node.position.x + NODE_W;
			const y1 = node.position.y + NODE_H / 2;
			setWireDrag( {
				fromId: nodeId,
				x1,
				y1,
				x2: x1,
				y2: y1,
				hoveredId: null,
			} );
		},
		[ editMode, onConnect, nodes ]
	);

	const handlePortPointerMove = useCallback(
		( e ) => {
			if ( ! wireDrag ) {
				return;
			}
			const svg = svgRef.current;
			if ( ! svg ) {
				return;
			}
			const local = screenToSvg( svg, e.clientX, e.clientY );
			// Snap-to-IN-port: any node whose IN port (left edge,
			// vertical center) is within PORT_HIT_R of the cursor wins,
			// except the source node (no self-edges).
			let snapTargetId = null;
			let bestDist = PORT_HIT_R;
			for ( const n of nodes ) {
				if ( n.id === wireDrag.fromId ) {
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
			setWireDrag( {
				...wireDrag,
				x2: local.x,
				y2: local.y,
				hoveredId: snapTargetId,
			} );
		},
		[ wireDrag, nodes ]
	);

	const handlePortPointerUp = useCallback(
		( e ) => {
			if ( ! wireDrag ) {
				return;
			}
			try {
				e.currentTarget.releasePointerCapture( e.pointerId );
			} catch ( _err ) {
				// already released
			}
			const { fromId, hoveredId: snapId } = wireDrag;
			setWireDrag( null );
			if ( snapId && onConnect ) {
				onConnect( fromId, snapId );
			}
		},
		[ wireDrag, onConnect ]
	);

	const handleDragOver = useCallback(
		( e ) => {
			if ( ! editMode ) {
				return;
			}
			// preventDefault is what marks the surface as a valid drop
			// target; without it, the browser refuses the drop and the
			// onDrop handler never fires.
			e.preventDefault();
			e.dataTransfer.dropEffect = 'copy';
		},
		[ editMode ]
	);

	const handleDrop = useCallback(
		( e ) => {
			if ( ! editMode || ! onDropNode || ! svgRef.current ) {
				return;
			}
			const shellName = e.dataTransfer.getData(
				'application/x-newspack-node'
			);
			if ( ! shellName ) {
				return;
			}
			e.preventDefault();
			// Project (clientX, clientY) → SVG-space (x, y) using the
			// current screen-CTM, so the drop position lands under the
			// cursor regardless of the active viewBox / zoom level.
			const pt = svgRef.current.createSVGPoint();
			pt.x = e.clientX;
			pt.y = e.clientY;
			const ctm = svgRef.current.getScreenCTM();
			if ( ! ctm ) {
				return;
			}
			const local = pt.matrixTransform( ctm.inverse() );
			onDropNode( { shellName, x: local.x, y: local.y } );
		},
		[ editMode, onDropNode ]
	);

	const defaultViewBox = useMemo(
		() => tightViewBoxFor( displayNodes ),
		[ displayNodes ]
	);
	const viewBox = viewport
		? `${ viewport.x } ${ viewport.y } ${ viewport.w } ${ viewport.h }`
		: defaultViewBox;
	// First-render commit: when there's no persisted viewport AND
	// we now have nodes, freeze the autofit result so subsequent
	// renders use it as-is. Without this, `viewport=null` makes
	// every render re-compute tightViewBoxFor from current node
	// positions, so a node drag would shift the whole canvas
	// in real time (live autofit). Click-canvas-to-autofit
	// already did this via setViewport; the initial state now
	// matches.
	useEffect( () => {
		if ( ! viewport && nodes.length > 0 ) {
			setViewport( parseViewBox( tightViewBoxFor( nodes ) ) );
		}
		// nodes used (not displayNodes) so an in-flight drag doesn't
		// trigger the commit — only "real" position changes do.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ viewport, nodes.length ] );

	// hoveredId is lifted to the parent so the Inspector can drive
	// it too (hovering a `target` / `← from` value in the inspector
	// highlights the same edges as hovering the node on the canvas).
	const setHovered = ( id ) => {
		if ( onHover ) {
			onHover( id );
		}
	};

	// Wheel zoom — anchored at the cursor so the world point under
	// the mouse stays under the mouse. preventDefault stops the page
	// from scrolling when the cursor is over the canvas.
	const handleWheel = ( e ) => {
		e.preventDefault();
		const svg = e.currentTarget;
		const world = screenToSvg( svg, e.clientX, e.clientY );
		const current = viewport || parseViewBox( defaultViewBox );
		const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
		// Clamp via the size — bigger viewBox = zoomed out. Compute
		// against the ORIGINAL default so the zoom limits make sense
		// across very different graph sizes.
		const baseW = parseViewBox( defaultViewBox ).w;
		const minW = baseW / ZOOM_MAX;
		const maxW = baseW / ZOOM_MIN;
		const nextW = Math.max( minW, Math.min( maxW, current.w * factor ) );
		const nextH = ( current.h / current.w ) * nextW;
		const fracX = ( world.x - current.x ) / current.w;
		const fracY = ( world.y - current.y ) / current.h;
		setViewport( {
			x: world.x - fracX * nextW,
			y: world.y - fracY * nextH,
			w: nextW,
			h: nextH,
		} );
	};

	// Pan on background drag. Nodes' pointerdown handlers stopPropagation,
	// so this only fires when the user grabs the empty canvas. On
	// pointerup, if the pointer never crossed the drag threshold, treat
	// the click as "deselect + autofit" — that's how the user re-centers
	// the graph after they've panned/zoomed away.
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
		// `preserveAspectRatio="xMidYMid meet"` uses min(rect/vb) as the
		// scale for both axes — read the actual rendered scale off the
		// SVG so panning matches cursor speed regardless of letterbox.
		const scale = Math.min(
			p.rect.width / p.startVb.w,
			p.rect.height / p.startVb.h
		);
		const worldDx = dxScreen / scale;
		const worldDy = dyScreen / scale;
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
			// Plain click on empty canvas. Two-stage:
			//   - If a node is selected, first click just deselects
			//     (closes the inspector). Don't autofit yet — the user
			//     probably wanted to dismiss the inspector, not jump
			//     the viewport.
			//   - If nothing is selected (inspector already closed),
			//     autofit to the tight bbox.
			if ( selectedId ) {
				if ( onDeselect ) {
					onDeselect();
				}
			} else {
				setViewport( parseViewBox( tightViewBoxFor( displayNodes ) ) );
			}
		}
	};

	const beginDrag = ( e, node ) => {
		// Only left-button drags; right/middle reserved for browser.
		if ( e.button !== 0 ) {
			return;
		}
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
			// Snap to HALF-steps of the auto-layout grid (X_STEP / 2,
			// Y_STEP / 2). Whole-step snap kept dragged nodes aligned
			// with auto-placed neighbors but didn't leave room to
			// "nudge between columns" — half-steps give that finer
			// control while still landing on a predictable lattice
			// (every other slot is a real auto-layout slot). Anchored
			// at X_PAD / Y_PAD so n=0 still matches the algorithm.
			// Negative xi / yi are allowed — a node dragged above or
			// left of the auto-layout origin is just a node the user
			// wanted there; pan/zoom + the tight-bbox autofit handle
			// the resulting viewport adjustment.
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
		// Reset the click-suppress flag on the next microtask so the
		// click handler that fires immediately after pointerup can
		// still see the "we just dragged" signal.
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
			onPointerMove={ ( e ) => {
				if ( wireDrag ) {
					handlePortPointerMove( e );
				} else {
					handleBgPointerMove( e );
				}
			} }
			onPointerUp={ ( e ) => {
				if ( wireDrag ) {
					handlePortPointerUp( e );
				} else {
					handleBgPointerUp( e );
				}
			} }
			onPointerCancel={ ( e ) => {
				if ( wireDrag ) {
					handlePortPointerUp( e );
				} else {
					handleBgPointerUp( e );
				}
			} }
			onWheel={ handleWheel }
			onDragOver={ handleDragOver }
			onDrop={ handleDrop }
		>
			<defs>
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

			<g className="topology-edges">
				{ edges.map( ( e, i ) => {
					const a = nodeById.get( e.from );
					const b = nodeById.get( e.to );
					if ( ! a || ! b ) {
						return null;
					}
					const hoverTouches =
						hoveredId === e.from || hoveredId === e.to;
					const selectTouches =
						! hoveredId &&
						( selectedId === e.from || selectedId === e.to );
					// Hover applies the bold highlight + dims everything
					// else. Selection applies the same bold highlight to
					// the selected node's edges but DOESN'T dim — the rest
					// of the graph stays at full intensity so the user can
					// still see the surrounding context.
					const touches = hoverTouches || selectTouches;
					const dimmed = hoveredId && ! hoverTouches;
					return (
						<path
							key={ `edge-${ i }-${ e.from }-${ e.to }` }
							className={ `topology-edge topology-edge--active${
								touches ? ' is-touched' : ''
							}${ dimmed ? ' is-dimmed' : '' }` }
							d={ edgePath( a, b ) }
							markerEnd="url(#topology-arrow-active)"
							style={ { animationDelay: `${ 200 + i * 80 }ms` } }
						/>
					);
				} ) }
			</g>

			<g className="topology-nodes">
				{ displayNodes.map( ( n, i ) => {
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
							}${ isDragging ? ' is-dragging' : '' }` }
							transform={ `translate(${ n.position.x },${ n.position.y })` }
							style={ { animationDelay: `${ i * 50 }ms` } }
							onClick={ ( ev ) => {
								ev.stopPropagation();
								// Suppress selection after a real drag —
								// pointer-up sets draggedRef to true in
								// that case. The flag is reset on the
								// next microtask so subsequent clicks
								// (without intervening drags) work.
								if ( draggedRef.current ) {
									draggedRef.current = false;
									return;
								}
								if ( onSelect ) {
									onSelect( n.id );
								}
							} }
							onPointerDown={ ( ev ) => beginDrag( ev, n ) }
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
								width={ NODE_W }
								height={ NODE_H }
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
								{ inferType( n.id ) }
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
							{ /* Per-node rate sparkline — client-side
							ring buffer of the last RATE_HISTORY_MAX
							samples (~1 minute at 1s tick cadence).
							Auto-scaled to the window's max so bursty
							nodes show their shape regardless of
							absolute magnitude. Hidden until we have
							two samples to draw a line between. */ }
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
							{ /* Per-node rate in the BOTTOM-left, baseline-
							aligned with the counter in the bottom-right.
							Reading from rateRef via the rateVersion-driven
							re-render — formatNodeRate hides values below a
							threshold so quiet nodes don't fill the canvas
							with "0 /s" noise. rateVersion is referenced
							indirectly: the prop change is what triggers
							this render path. */ }
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
							<circle
								className={ `topology-port topology-port--out${
									editMode ? ' is-edit' : ''
								}` }
								cx={ NODE_W }
								cy={ NODE_H / 2 }
								r={ PORT_R }
								onPointerDown={ ( e ) =>
									handlePortPointerDown( n.id, e )
								}
							/>
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
