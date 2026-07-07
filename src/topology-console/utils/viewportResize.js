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
 * @param {?{x:number,y:number,w:number,h:number}} args.viewport Current viewport (world units); `null` = uncontrolled (returned as-is).
 * @param {{w:number,h:number}}                    args.oldPx    Canvas px the current viewport was reconciled for.
 * @param {{w:number,h:number}}                    args.newPx    Canvas px after the resize.
 * @param {number}                                 args.fitOld   Autofit scale (px/world) at `oldPx`.
 * @param {number}                                 args.fitNew   Autofit scale (px/world) at `newPx`.
 * @return {?{x:number,y:number,w:number,h:number}} Reconciled viewport, or the input unchanged when inputs are unusable.
 */
export function resizeViewportTrackingAutofit( {
	viewport,
	oldPx,
	newPx,
	fitOld,
	fitNew,
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
	const cx = viewport.x + viewport.w / 2;
	const cy = viewport.y + viewport.h / 2;
	return { x: cx - w / 2, y: cy - h / 2, w, h };
}
