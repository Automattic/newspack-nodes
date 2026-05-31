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
 * @param {number}                                          [opts.margin]           World-unit cull margin (default 2 node-widths).
 * @return {{visibleIds:Set<string>, showDetail:boolean, scale:number}} The set of
 *   node ids to render, whether to draw labels, and the px/unit scale.
 */
export function viewportCull( nodes, viewBox, canvas, opts = {} ) {
	const nodeW = opts.nodeW ?? 196;
	const nodeH = opts.nodeH ?? 84;
	const detailScale = opts.detailScale ?? 0.35;
	// Strict by default: only nodes intersecting the viewBox render (edges to a
	// just-off-screen node still draw — they anchor at the on-screen endpoint).
	const margin = opts.margin ?? 0;

	// Effective scale (px per world unit) under SVG preserveAspectRatio="meet":
	// the smaller of the width- and height-fit ratios. A tall-narrow graph is
	// height-bound, so the width ratio alone would wrongly read as zoomed-in.
	// Unmeasured canvas (first render / jsdom) → assume readable, show detail.
	const fits = canvas.w > 0 && canvas.h > 0 && viewBox.w > 0 && viewBox.h > 0;
	const scale = fits
		? Math.min( canvas.w / viewBox.w, canvas.h / viewBox.h )
		: Infinity;
	const showDetail = scale >= detailScale;

	const left = viewBox.x - margin;
	const right = viewBox.x + viewBox.w + margin;
	const top = viewBox.y - margin;
	const bottom = viewBox.y + viewBox.h + margin;

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

	return { visibleIds, showDetail, scale };
}

/**
 * Whether an edge should render, given which nodes are on-screen and each node's
 * degree. Both endpoints visible → always. Neither → never. Exactly one visible →
 * only when that node is low-degree; a high-degree hub would otherwise flood the
 * canvas with edges to its (off-screen) neighbours.
 *
 * @param {string}      from
 * @param {string}      to
 * @param {Set<string>} visibleIds         Node ids intersecting the viewport.
 * @param {Object}      degree             Map of node id → edge count.
 * @param {Object}      [opts]
 * @param {number}      [opts.lodDegree=8] Max degree for an off-screen edge to draw.
 * @return {boolean} True if the edge should be rendered.
 */
export function isEdgeVisible( from, to, visibleIds, degree, opts = {} ) {
	const lodDegree = opts.lodDegree ?? 8;
	const fromVis = visibleIds.has( from );
	const toVis = visibleIds.has( to );
	if ( fromVis && toVis ) {
		return true;
	}
	if ( ! fromVis && ! toVis ) {
		return false;
	}
	const visNode = fromVis ? from : to;
	return ( degree[ visNode ] ?? 0 ) <= lodDegree;
}
