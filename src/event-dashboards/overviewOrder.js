/**
 * overviewOrder — pure ordering helpers for the Overview tab's ACTIVE topology
 * list. The display order is the user's persisted drag order reconciled against
 * the live set; drag moves are computed against the currently-rendered order.
 * No DOM, no storage — both halves are fully unit-tested.
 */

/**
 * Resolve the display order of active topologies: persisted names first (in
 * stored order, filtered to those still active), then any remaining active
 * names not in the stored order, appended alphabetically. So a brand-new
 * topology lands stably at the end and a removed one drops out.
 *
 * @param {string[]} activeNames Live active topology names.
 * @param {string[]} storedOrder The user's persisted order (may contain stale names).
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
 * Live pointer-drag reorder: move `draggedName` to the slot the cursor's Y is
 * over. `rects` are the rendered rows' vertical bounds IN DISPLAY ORDER; the
 * insertion slot is the count of rows whose vertical midpoint is above `y`
 * (so the dragged row follows the cursor in BOTH directions, not just up). The
 * dragged row's own removal is accounted for so a downward drag isn't sticky.
 *
 * @param {string[]}                          names       Current display order.
 * @param {string}                            draggedName The name being dragged.
 * @param {Array<{top:number,bottom:number}>} rects       Row bounds, aligned to `names`.
 * @param {number}                            y           Pointer clientY.
 * @return {string[]} The new display order (unchanged if dragged isn't present).
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
 * Live gap-opening for the float drag: given the cached row geometry, which row
 * is being dragged, its vertical offset, and the cursor Y, return the translateY
 * each row should carry — the dragged row floats by `dy`, and the rows it has
 * passed shift one slot to OPEN the gap it will drop into. All compositor
 * transforms; no React render. Mirrors `dragReorder`'s slot math so the visible
 * gap and the committed order agree.
 *
 * @param {Array<{top:number,bottom:number}>} rects     Row bounds in display order.
 * @param {number}                            fromIndex Index of the dragged row.
 * @param {number}                            dy        Dragged row's pixel offset from grab.
 * @param {number}                            y         Pointer clientY.
 * @return {{ transforms: number[], toIndex: number }} Per-row translateY + the target slot.
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
 * carrying any prior names that aren't currently active (inactive/stale) so a
 * drag performed while a topology is down doesn't erase its saved slot. Carried
 * names keep their prior relative order, appended after the active order.
 *
 * @param {string[]} priorOrder  The full persisted order (may hold inactive names).
 * @param {string[]} activeOrder The new display order of the active names.
 * @return {string[]} The full order to persist.
 */
export function mergeStoredOrder( priorOrder, activeOrder ) {
	const inActive = new Set( activeOrder );
	const carried = priorOrder.filter( ( name ) => ! inActive.has( name ) );
	return [ ...activeOrder, ...carried ];
}
