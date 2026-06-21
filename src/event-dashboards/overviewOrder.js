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
 * Compute a drag-reorder move: remove `draggedName` and re-insert it
 * immediately before `targetName`'s position. A no-op (returns the input
 * unchanged) when dragged === target or either name is missing.
 *
 * @param {string[]} currentOrder The full current display order.
 * @param {string}   draggedName  The name being dragged.
 * @param {string}   targetName   The name to drop before.
 * @return {string[]} The new order (or `currentOrder` unchanged on a no-op).
 */
export function reorderNames( currentOrder, draggedName, targetName ) {
	if (
		draggedName === targetName ||
		! currentOrder.includes( draggedName ) ||
		! currentOrder.includes( targetName )
	) {
		return currentOrder;
	}
	const without = currentOrder.filter( ( name ) => name !== draggedName );
	const at = without.indexOf( targetName );
	return [ ...without.slice( 0, at ), draggedName, ...without.slice( at ) ];
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
