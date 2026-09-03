/**
 * Ordering rules for the Overview tab's ACTIVE topology list, kept out of the
 * component so a drag can be reasoned about without a DOM.
 *
 * Rows follow the user's persisted drag order reconciled against the live
 * active set, never health — ordering by health reshuffles the list whenever a
 * worker flaps. Geometry arrives as plain rects, so one piece of slot
 * arithmetic serves both the gap that opens during a drag and the order
 * committed on drop.
 */

/**
 * Resolve the display order of active topologies: persisted names first, in
 * stored order and filtered to those still active, then the remaining active
 * names appended alphabetically. Alphabetical rather than the order the server
 * listed them in keeps a brand-new topology in the same slot on every load, and
 * a stored name that is no longer active drops out.
 *
 * @param {string[]} activeNames Live active topology names.
 * @param {string[]} storedOrder The user's persisted order, which may name topologies that are no longer active.
 * @return {string[]} Names in display order.
 */
export function orderTopologies( activeNames, storedOrder ) {
	const live = new Set( activeNames );
	const stored = storedOrder.filter( ( name ) => live.has( name ) );
	const seen = new Set( stored );
	const rest = activeNames
		.filter( ( name ) => ! seen.has( name ) )
		.sort( ( a, b ) => a.localeCompare( b ) );
	return [ ...stored, ...rest ];
}

/**
 * Move `draggedName` to the slot the cursor's Y is over. The insertion slot is
 * the count of rows whose vertical midpoint sits above `y`, so the dragged row
 * follows the cursor in both directions. Removing the dragged row shifts every
 * slot below it up by one, which is what keeps a downward drag from sticking.
 *
 * @param {string[]}                          names       Current display order.
 * @param {string}                            draggedName The name being dragged.
 * @param {Array<{top:number,bottom:number}>} rects       Row bounds, aligned index-for-index with `names`.
 * @param {number}                            y           Pointer clientY.
 * @return {string[]} The new display order, or `names` unchanged when `draggedName` is absent.
 */
export function dragReorder( names, draggedName, rects, y ) {
	const cur = names.indexOf( draggedName );
	if ( cur === -1 ) {
		return names;
	}
	let slot = 0;
	for ( const r of rects ) {
		if ( ( r.top + r.bottom ) / 2 < y ) {
			slot++;
		}
	}
	// `slot` counts the full list; removing the dragged row shifts slots -1.
	const insertAt = slot > cur ? slot - 1 : slot;
	const without = names.filter( ( name ) => name !== draggedName );
	const at = Math.max( 0, Math.min( without.length, insertAt ) );
	return [ ...without.slice( 0, at ), draggedName, ...without.slice( at ) ];
}

/**
 * Compute the translateY each row should carry mid-drag: the dragged row floats
 * by `dy`, and every row it has passed shifts one slot to open the gap it will
 * drop into. The caller writes these straight to `style.transform`, so a drag
 * costs compositor work and no React render. The slot arithmetic mirrors
 * `dragReorder`, so the visible gap and the order committed on drop agree.
 *
 * The displacement pitch is measured at the dragged row's own neighbour rather
 * than assumed uniform, because an unfolded topology row is taller than a
 * folded one.
 *
 * @param {Array<{top:number,bottom:number}>} rects     Row bounds in display order.
 * @param {number}                            fromIndex Index of the dragged row.
 * @param {number}                            dy        Dragged row's pixel offset from the grab point.
 * @param {number}                            y         Pointer clientY.
 * @return {{transforms:number[],toIndex:number}} Per-row translateY, and the slot the dragged row would land in.
 */
export function dragGapTransforms( rects, fromIndex, dy, y ) {
	let slot = 0;
	for ( const r of rects ) {
		if ( ( r.top + r.bottom ) / 2 < y ) {
			slot++;
		}
	}
	const toIndex = Math.max(
		0,
		Math.min( rects.length - 1, slot > fromIndex ? slot - 1 : slot )
	);
	// Displaced rows travel one slot pitch (row height + inter-row gap).
	let pitch = 0;
	if ( rects.length > 1 ) {
		const lo = fromIndex < rects.length - 1 ? fromIndex : fromIndex - 1;
		pitch = rects[ lo + 1 ].top - rects[ lo ].top;
	}
	const transforms = rects.map( ( _r, i ) => {
		if ( i === fromIndex ) {
			return dy;
		}
		if ( fromIndex < toIndex && i > fromIndex && i <= toIndex ) {
			return -pitch;
		}
		if ( toIndex < fromIndex && i >= toIndex && i < fromIndex ) {
			return pitch;
		}
		return 0;
	} );
	return { transforms, toIndex };
}

/**
 * Fold a freshly-reordered ACTIVE order back into the full persisted order,
 * carrying any prior names that are not currently active, so a drag performed
 * while a topology is down does not drop that topology from the saved order.
 * Carried names keep their prior relative order and follow the active order.
 *
 * @param {string[]} priorOrder  The full persisted order, which may hold inactive names.
 * @param {string[]} activeOrder The new display order of the active names.
 * @return {string[]} The full order to persist.
 */
export function mergeStoredOrder( priorOrder, activeOrder ) {
	const inActive = new Set( activeOrder );
	const carried = priorOrder.filter( ( name ) => ! inActive.has( name ) );
	return [ ...activeOrder, ...carried ];
}
