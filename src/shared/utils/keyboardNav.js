/**
 * Arrow-key geometry the canvas and its sidecar grids share: which way each
 * arrow points, the card an arrow moves to, and the least pan that brings a
 * card into view.
 */

/** @typedef {{x: number, y: number, w: number, h: number}} Box */

/**
 * Which way each arrow key points, as an `[x, y]` unit vector. A key absent
 * from the table is left to the page.
 */
export const ARROWS = {
	ArrowLeft: [ -1, 0 ],
	ArrowRight: [ 1, 0 ],
	ArrowUp: [ 0, -1 ],
	ArrowDown: [ 0, 1 ],
};

/**
 * How much a centre off the arrow's axis costs against one ahead along it.
 */
const ACROSS_WEIGHT = 2;

/**
 * The card an arrow moves to from `from`. Only a card whose centre lies ahead
 * along the arrow qualifies, and the one scoring least wins, where its score
 * is its centre's distance along the arrow plus twice its distance off the
 * arrow's axis; the earlier card in `boxes` wins a tie.
 *
 * @template {Box} T
 * @param {T[]}              boxes Every card, `from` among them.
 * @param {T}                from  The card the arrow starts at.
 * @param {[number, number]} dir   The arrow, as `ARROWS` gives it.
 * @return {T|undefined} The card, or undefined at an edge.
 */
export function nearestInDirection( boxes, from, [ dx, dy ] ) {
	const cx = from.x + from.w / 2;
	const cy = from.y + from.h / 2;
	let best;
	let bestScore = Infinity;
	for ( const box of boxes ) {
		const ox = box.x + box.w / 2 - cx;
		const oy = box.y + box.h / 2 - cy;
		const along = ox * dx + oy * dy;
		if ( along <= 0 ) {
			continue;
		}
		const score = along + ACROSS_WEIGHT * Math.abs( ox * dy - oy * dx );
		if ( score < bestScore ) {
			best = box;
			bestScore = score;
		}
	}
	return best;
}

/**
 * The card whose centre lies nearest a point, the earlier in `boxes` on a tie.
 *
 * @template {Box} T
 * @param {T[]}    boxes Every card.
 * @param {number} x     The point, in world units.
 * @param {number} y     The point, in world units.
 * @return {T|undefined} The card, or undefined with none.
 */
export function nearestTo( boxes, x, y ) {
	let best;
	let bestDist = Infinity;
	for ( const box of boxes ) {
		const dist = Math.hypot( box.x + box.w / 2 - x, box.y + box.h / 2 - y );
		if ( dist < bestDist ) {
			best = box;
			bestDist = dist;
		}
	}
	return best;
}

/**
 * The view moved the least distance that shows all of `box`, its top-left
 * corner first where the box outsizes the view.
 *
 * @param {Box}    view   The viewBox, in world units.
 * @param {Box}    box    The card to show.
 * @param {number} hidden World units the bottom of the view hides.
 * @return {Box} `view` itself when the card already shows, else a new view.
 */
export function viewToShow( view, box, hidden ) {
	const shift = ( start, size, at, extent ) =>
		Math.min( at - start, Math.max( 0, at + extent - ( start + size ) ) );
	const dx = shift( view.x, view.w, box.x, box.w );
	const dy = shift( view.y, view.h - hidden, box.y, box.h );
	return dx || dy ? { ...view, x: view.x + dx, y: view.y + dy } : view;
}
