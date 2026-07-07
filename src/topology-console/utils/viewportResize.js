/**
 * Reconcile the canvas viewport across a resize so the displayed scale TRACKS
 * autofit without re-framing (autofit's centering is intentionally NOT applied).
 *
 * The scale autofit would pick is a pure function of the canvas px and the node
 * bbox — independent of pan — so `fitOld`/`fitNew` (the autofit px-per-world
 * scale at the old/new canvas size) are computed by the caller and passed in.
 *
 * The reconciled viewport keeps the current CENTER, takes the new canvas aspect
 * (so `preserveAspectRatio="meet"` can't letterbox), and sets its scale to
 * `fitNew × (currentScale / fitOld)` — i.e. it preserves the current zoom RATIO
 * relative to autofit. Consequences: the scale only drops when autofit drops
 * (no letterbox under-shrink), grows in step with autofit when the canvas grows,
 * and a manual wheel-zoom survives the resize (at a fit view the ratio is 1, so
 * a fit view stays exactly fit).
 *
 * @param {Object}                                 args
 * @param {?{x:number,y:number,w:number,h:number}} args.viewport  Current viewport (world units); `null` = uncontrolled (returned as-is).
 * @param {{w:number,h:number}}                    args.oldPx     Canvas px the current viewport was reconciled for.
 * @param {{w:number,h:number}}                    args.newPx     Canvas px after the resize.
 * @param {number}                                 args.fitOld    Autofit scale (px/world) at `oldPx`.
 * @param {number}                                 args.fitNew    Autofit scale (px/world) at `newPx`.
 * @param {?{x:number,y:number}}                   args.oldCenter Autofit viewBox center at oldPx/oldInset; omit to hold the raw center (window/sidebar resize).
 * @param {?{x:number,y:number}}                   args.newCenter Autofit viewBox center at newPx/newInset; when it differs from oldCenter the framing follows it (transcript reflow).
 * @return {?{x:number,y:number,w:number,h:number}} Reconciled viewport, or the input unchanged when inputs are unusable.
 */
/**
 * The largest bottom inset (transcript height) that still leaves the graph's
 * height-bound autofit scale at or above the LOD threshold — i.e. the point
 * "right above where the nodes drop to bare rects". The reconcile clamps the
 * effective inset to this so the transcript can't shrink the graph below LOD;
 * beyond it the transcript just overlays.
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

export function resizeViewportTrackingAutofit( {
	viewport,
	oldPx,
	newPx,
	fitOld,
	fitNew,
	oldCenter,
	newCenter,
} ) {
	if ( ! viewport || ! ( viewport.w > 0 ) || ! ( viewport.h > 0 ) ) {
		return viewport;
	}
	if ( ! oldPx?.w || ! oldPx?.h || ! newPx?.w || ! newPx?.h ) {
		return viewport;
	}
	if ( ! ( fitOld > 0 ) || ! ( fitNew > 0 ) ) {
		return viewport;
	}
	// Displayed scale of the current viewport (meet-fit = the binding dimension).
	const oldScale = Math.min( oldPx.w / viewport.w, oldPx.h / viewport.h );
	const ratio = oldScale / fitOld;
	const targetScale = fitNew * ratio;
	const w = newPx.w / targetScale;
	const h = newPx.h / targetScale;
	// Preserve the pan offset relative to the AUTOFIT center, not the raw center:
	// a pure resize leaves the autofit center put (→ raw center held), but when
	// the autofit center shifts (the transcript opening moves it up into the band)
	// the framing rides that shift. Omitting the centers keeps the raw center.
	const cx = viewport.x + viewport.w / 2;
	const cy = viewport.y + viewport.h / 2;
	const oc = oldCenter ?? { x: cx, y: cy };
	const nc = newCenter ?? { x: cx, y: cy };
	const centerX = nc.x + ( cx - oc.x );
	const centerY = nc.y + ( cy - oc.y );
	return { x: centerX - w / 2, y: centerY - h / 2, w, h };
}
