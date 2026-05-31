/**
 * Decide which nodes to render and at what detail for a given viewport, so a
 * large graph (thousands of cards) doesn't put every node — and every label —
 * in the DOM at once.
 *
 * Two independent reductions:
 *  - Spatial: only nodes whose card (plus a margin so edges to just-off-screen
 *    nodes still anchor) intersect the viewBox are returned in `visibleIds`.
 *  - Detail: when the scale (canvas pixels per world unit) is below
 *    `detailScale`, labels would be sub-pixel and unreadable, so `showDetail`
 *    is false and the renderer should draw bare cards (no text/sparkline/ports).
 *
 * @param {Array<{id:string,position:{x:number,y:number}}>} nodes
 * @param {{x:number,y:number,w:number,h:number}}           viewBox                 Visible world rect.
 * @param {{w:number,h:number}}                             canvas                  Canvas size in CSS pixels (0 when unmeasured).
 * @param {Object}                                          [opts]
 * @param {number}                                          [opts.nodeW=196]
 * @param {number}                                          [opts.nodeH=84]
 * @param {number}                                          [opts.detailScale=0.35] px/unit below which labels are dropped.
 * @param {number}                                          [opts.overscan=0]       Off-screen render band as a fraction of the viewBox per axis.
 * @param {number}                                          [opts.margin]           Absolute world-unit cull margin (overrides overscan, both axes).
 * @return {{visibleIds:Set<string>, showDetail:boolean, scale:number, region:{x:number,y:number,w:number,h:number}}}
 *   The node ids to render, whether to draw labels, the px/unit scale, and the
 *   on-screen clip rect (for truncating one-endpoint-visible edges).
 */
export function viewportCull( nodes, viewBox, canvas, opts = {} ) {
	const nodeW = opts.nodeW ?? 196;
	const nodeH = opts.nodeH ?? 84;
	const detailScale = opts.detailScale ?? 0.35;
	const overscan = opts.overscan ?? 0;

	// Effective scale (px per world unit) under SVG preserveAspectRatio="meet":
	// the smaller of the width- and height-fit ratios. A tall-narrow graph is
	// height-bound, so the width ratio alone would wrongly read as zoomed-in.
	// Unmeasured canvas (first render / jsdom) → assume readable, show detail.
	const fits = canvas.w > 0 && canvas.h > 0 && viewBox.w > 0 && viewBox.h > 0;
	const scale = fits
		? Math.min( canvas.w / viewBox.w, canvas.h / viewBox.h )
		: Infinity;
	const showDetail = scale >= detailScale;

	// The TRUE on-screen world region under "meet": the viewBox expanded to the
	// canvas aspect. The under-constrained axis letterboxes, showing world BEYOND
	// the viewBox — so culling against the raw viewBox would drop a node the moment
	// a tall-narrow column is panned into that (still-visible) letterbox margin.
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

	// Overscan: render a band of just-off-screen nodes (a fraction of the visible
	// region on each axis) so panning scrolls smoothly instead of popping the
	// leading edge. Default 0 (strict). An absolute `margin` (used by tests)
	// overrides it on both axes.
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
		// The clip rect (on-screen region + overscan) so a one-endpoint-visible
		// edge can be truncated to the viewport instead of drawn as a giant bezier
		// out to its off-screen peer.
		region: { x: left, y: top, w: right - left, h: bottom - top },
	};
}

/**
 * Exit point where the segment (x0,y0)→(x1,y1) leaves a rect, assuming (x0,y0)
 * is inside it (Liang-Barsky exit parameter). Used to truncate an edge whose
 * far endpoint is off-screen to where it crosses the viewport boundary. If the
 * target is also inside, returns it unchanged.
 *
 * @param {number}                                x0
 * @param {number}                                y0
 * @param {number}                                x1
 * @param {number}                                y1
 * @param {{x:number,y:number,w:number,h:number}} rect
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
 * cull only when BOTH are off-screen. An edge with one visible endpoint anchors
 * there and trails toward its off-screen peer.
 *
 * @param {string}      from
 * @param {string}      to
 * @param {Set<string>} visibleIds Node ids intersecting the viewport.
 * @return {boolean} True if the edge should be rendered.
 */
export function isEdgeVisible( from, to, visibleIds ) {
	return visibleIds.has( from ) || visibleIds.has( to );
}
