/**
 * The largest bottom inset (transcript height) that still leaves the graph's
 * height-bound autofit scale at or above the LOD threshold — i.e. the point
 * "right above where the nodes drop to bare rects". The resize re-derive clamps
 * the effective inset to this so the transcript can't shrink the graph below LOD;
 * beyond it the transcript just overlays.
 *
 * (The former `resizeViewportTrackingAutofit` reconcile that consumed this was
 * folded into the delta model — see `autofitDelta.js`; the resize now re-derives
 * the viewport as `viewportFromDelta(deltaFromAutofit(vp, oldFit), newFit)`.)
 *
 * @param {Object} args
 * @param {number} args.canvasH     Canvas height in px.
 * @param {number} args.bboxH       Node bounding-box height in world units.
 * @param {number} args.detailScale LOD scale (px/world) — must match viewportCull's `detailScale`.
 * @param {number} args.fill        Autofit fill fraction (AUTOFIT_FILL).
 * @return {number} Max inset px, or Infinity when the bbox/inputs are unknown (no clamp).
 */
export function maxInsetBeforeLOD( { canvasH, bboxH, detailScale, fill } ) {
	if (
		! ( bboxH > 0 ) ||
		! ( canvasH > 0 ) ||
		! ( detailScale > 0 ) ||
		! ( fill > 0 )
	) {
		return Infinity;
	}
	const minUsableH = ( detailScale * bboxH ) / fill;
	return Math.max( 0, canvasH - minUsableH );
}
