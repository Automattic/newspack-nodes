/**
 * Persist the canvas viewport as a DELTA from autofit, not as absolute viewBox
 * coordinates. The delta is `{ dcx, dcy, zoom }`: the pan is the viewport CENTER
 * minus the autofit center (world units), and `zoom` is the displayed-scale
 * RATIO to autofit (`autofit.w / viewport.w`, since scale = px/width). So the
 * zero delta `{ 0, 0, 1 }` IS autofit.
 *
 * Storing the delta instead of the viewBox means a restore re-derives against
 * the autofit for the CURRENT canvas size: a never-touched (zero-delta) view
 * stays exactly autofit no matter how the window/overlay/transcript resized it,
 * and a panned/zoomed view keeps the same world offset + zoom-ratio relative to
 * the new fit. Convert at the persist/restore boundary only; the live viewport
 * stays a viewBox.
 *
 * @param {?{x:number,y:number,w:number,h:number}} viewport Live viewBox (world units).
 * @param {?{x:number,y:number,w:number,h:number}} autofit  Autofit viewBox for the same nodes+canvas.
 * @return {?{dcx:number,dcy:number,zoom:number}} The delta, or null if inputs are unusable.
 */
export function deltaFromAutofit( viewport, autofit ) {
	if ( ! isBox( viewport ) || ! isBox( autofit ) ) {
		return null;
	}
	return {
		dcx: viewport.x + viewport.w / 2 - ( autofit.x + autofit.w / 2 ),
		dcy: viewport.y + viewport.h / 2 - ( autofit.y + autofit.h / 2 ),
		zoom: autofit.w / viewport.w,
	};
}

/**
 * Inverse of {@link deltaFromAutofit}: re-derive a live viewBox from a stored
 * delta and the CURRENT autofit. Takes the autofit's aspect (so
 * `preserveAspectRatio="meet"` can't letterbox), applies the zoom ratio, then
 * offsets the center by the stored pan.
 *
 * @param {?{dcx:number,dcy:number,zoom:number}}   delta   Stored delta.
 * @param {?{x:number,y:number,w:number,h:number}} autofit Autofit viewBox for the current nodes+canvas.
 * @return {?{x:number,y:number,w:number,h:number}} The viewBox, or null if inputs are unusable.
 */
export function viewportFromDelta( delta, autofit ) {
	if ( ! delta || ! ( delta.zoom > 0 ) || ! isBox( autofit ) ) {
		return null;
	}
	const w = autofit.w / delta.zoom;
	const h = autofit.h / delta.zoom;
	const cx = autofit.x + autofit.w / 2 + delta.dcx;
	const cy = autofit.y + autofit.h / 2 + delta.dcy;
	return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function isBox( b ) {
	return (
		!! b &&
		b.w > 0 &&
		b.h > 0 &&
		Number.isFinite( b.x ) &&
		Number.isFinite( b.y )
	);
}
