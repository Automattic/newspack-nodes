/**
 * The viewport pass the schematic canvas runs before every render: which nodes
 * reach the DOM, at what level of detail, and how far an edge with an
 * off-screen endpoint is drawn. A topology of a few thousand cards would
 * otherwise put every card, label and wire in the document at once.
 *
 * `viewportCull` makes the decision; `isEdgeVisible` and `clipSegmentExit`
 * apply it to the edges, which straddle the boundary the node cull draws.
 */

/**
 * Decide which nodes to render, and whether to render their detail, for one
 * viewport.
 *
 * Two independent reductions:
 *  - Spatial: `visibleIds` holds the nodes whose card intersects the viewport
 *    plus an overscan band, so a pan uncovers cards already in the DOM and an
 *    edge to a just-off-screen node still anchors.
 *  - Detail: below `detailScale` canvas pixels per world unit a label is
 *    sub-pixel and unreadable, so `showDetail` is false and the renderer draws
 *    bare cards (no text, sparkline or ports).
 *
 * The cull runs against the viewBox expanded to the canvas aspect ratio:
 * `preserveAspectRatio="meet"` shows the letterbox world beyond the rect the
 * viewBox asks for, so culling against the raw viewBox blanks nodes that are
 * on screen.
 *
 * @param {Array<{id:string,position:{x:number,y:number}}>} nodes                   Every node in the graph; only `id` and `position` are read.
 * @param {{x:number,y:number,w:number,h:number}}           viewBox                 Requested visible world rect.
 * @param {{w:number,h:number}}                             canvas                  Canvas size in CSS pixels (0 when unmeasured).
 * @param {Object}                                          [opts]
 * @param {number}                                          [opts.nodeW=196]        Card width in world units; the canvas passes its own NODE_W.
 * @param {number}                                          [opts.nodeH=84]         Card height in world units; the canvas passes its own NODE_H.
 * @param {number}                                          [opts.detailScale=0.35] px/unit below which labels are dropped.
 * @param {number}                                          [opts.overscan=0]       Off-screen render band as a fraction of the viewBox per axis.
 * @param {number}                                          [opts.margin]           Absolute world-unit cull margin (overrides overscan, both axes).
 * @return {{visibleIds:Set<string>, showDetail:boolean, scale:number, region:{x:number,y:number,w:number,h:number}, visibleRegion:{x:number,y:number,w:number,h:number}}}
 *   The node ids to render (with overscan), whether to draw labels, the px/unit
 *   scale, the overscanned clip rect (for truncating one-endpoint-visible
 *   edges), and the strict on-screen rect the bloom filter pins to. `scale` is
 *   Infinity while the canvas is unmeasured, which keeps detail on rather than
 *   flashing bare rects on the first render.
 */
export function viewportCull( nodes, viewBox, canvas, opts = {} ) {
	const nodeW = opts.nodeW ?? 196;
	const nodeH = opts.nodeH ?? 84;
	const detailScale = opts.detailScale ?? 0.35;
	const overscan = opts.overscan ?? 0;

	// Effective scale under "meet": min of width/height fit ratios.
	const fits = canvas.w > 0 && canvas.h > 0 && viewBox.w > 0 && viewBox.h > 0;
	const scale = fits
		? Math.min( canvas.w / viewBox.w, canvas.h / viewBox.h )
		: Infinity;
	const showDetail = scale >= detailScale;

	// Expand viewBox to canvas aspect ("meet") — the letterbox stays visible.
	let visX = viewBox.x;
	let visY = viewBox.y;
	let visW = viewBox.w;
	let visH = viewBox.h;
	if ( fits ) {
		visW = canvas.w / scale;
		visH = canvas.h / scale;
		visX = viewBox.x + ( viewBox.w - visW ) / 2;
		visY = viewBox.y + ( viewBox.h - visH ) / 2;
	}

	// Overscan band of off-screen nodes for smooth panning; `margin` overrides.
	const marginX = opts.margin ?? visW * overscan;
	const marginY = opts.margin ?? visH * overscan;

	const left = visX - marginX;
	const right = visX + visW + marginX;
	const top = visY - marginY;
	const bottom = visY + visH + marginY;

	const visibleIds = new Set();
	for ( const n of nodes ) {
		const { x, y } = n.position;
		if (
			x + nodeW >= left &&
			x <= right &&
			y + nodeH >= top &&
			y <= bottom
		) {
			visibleIds.add( n.id );
		}
	}

	return {
		visibleIds,
		showDetail,
		scale,
		// Clip rect (on-screen + overscan) to truncate one-endpoint edges.
		region: { x: left, y: top, w: right - left, h: bottom - top },
		// Strict on-screen rect (no overscan): bloom pins its filter here.
		visibleRegion: { x: visX, y: visY, w: visW, h: visH },
	};
}

/**
 * Exit point where the segment from (x0,y0) to (x1,y1) leaves a rect, taking
 * (x0,y0) as inside it (the Liang-Barsky exit parameter). The canvas draws an
 * edge whose far endpoint is off-screen as a stub running from the visible
 * port to this point. A target already inside the rect comes back unchanged,
 * because the exit parameter clamps to 1; a start OUTSIDE the rect yields a
 * meaningless point rather than an error, so the caller passes the endpoint it
 * knows is visible.
 *
 * @param {number}                                x0   Start x, inside `rect`.
 * @param {number}                                y0   Start y, inside `rect`.
 * @param {number}                                x1   End x, usually outside.
 * @param {number}                                y1   End y, usually outside.
 * @param {{x:number,y:number,w:number,h:number}} rect Clip rect in world units.
 * @return {{x:number,y:number}} The clipped endpoint.
 */
export function clipSegmentExit( x0, y0, x1, y1, rect ) {
	const dx = x1 - x0;
	const dy = y1 - y0;
	let tExit = 1;
	// For each outward boundary p·t <= q, the exit bound is q/p when p > 0.
	const consider = ( p, q ) => {
		if ( p > 0 ) {
			tExit = Math.min( tExit, q / p );
		}
	};
	consider( dx, rect.x + rect.w - x0 ); // x <= right
	consider( -dx, x0 - rect.x ); // x >= left
	consider( dy, rect.y + rect.h - y0 ); // y <= bottom
	consider( -dy, y0 - rect.y ); // y >= top
	tExit = Math.max( 0, Math.min( 1, tExit ) );
	return { x: x0 + tExit * dx, y: y0 + tExit * dy };
}

/**
 * Whether an edge should render: show it if EITHER endpoint is on-screen, and
 * cull only when BOTH are off-screen. An edge with one visible endpoint
 * anchors there and trails toward its off-screen peer; culling it instead
 * would make the on-screen node read as unconnected.
 *
 * @param {string}      from       Source node id.
 * @param {string}      to         Target node id.
 * @param {Set<string>} visibleIds Node ids intersecting the viewport.
 * @return {boolean} True if the edge should be rendered.
 */
export function isEdgeVisible( from, to, visibleIds ) {
	return visibleIds.has( from ) || visibleIds.has( to );
}
