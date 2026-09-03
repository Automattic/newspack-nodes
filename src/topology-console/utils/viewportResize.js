/**
 * The largest bottom inset — the band autofit reserves for the transcript —
 * that still leaves the graph's height-bound autofit scale at or above
 * `detailScale`, the scale below which cards drop to bare rects. Autofit clamps
 * its inset to this, so a transcript taller than the cap overlays the graph
 * instead of shrinking it out of legibility.
 *
 * The height-bound autofit scale is `fill * ( canvasH - inset ) / bboxH`;
 * holding that at `detailScale` and solving for the inset gives the cap. Only
 * the height term is modelled, because only the inset moves it: a graph whose
 * WIDTH binds the fit sits at the scale its width allows however the band is
 * clamped. A graph already taller than the canvas caps at 0, reserving no band.
 *
 * @param {Object} args
 * @param {number} args.canvasH     Canvas height in px.
 * @param {number} args.bboxH       Node bounding-box height in world units.
 * @param {number} args.detailScale Scale in px per world unit the fit must hold; `SchematicCanvas` passes `LOD_FLOOR_SCALE`, a hair over `viewportCull`'s `detailScale`, so rounding cannot tip a fit-all view into bare rects.
 * @param {number} args.fill        Fraction of the canvas a fit-all viewport fills (`AUTOFIT_FILL`).
 * @return {number} The cap in px, or Infinity when an input is missing or non-positive, which leaves the caller's clamp inert.
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
