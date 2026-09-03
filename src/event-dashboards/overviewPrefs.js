/**
 * overviewPrefs — the Overview board's remembered layout: the drag order of
 * the active topologies, which of them are unfolded, and which entities inside
 * a topology's tree are folded shut. Overview seeds its React state from these
 * readers and writes back on every change, so a reload restores the board the
 * user arranged rather than the default one.
 *
 * The two fold sets are inverted, each naming the exceptions to its own
 * default: a topology row stays folded until it appears in the EXPANDED set,
 * while a within-tree entity stays open until it appears in the COLLAPSED set.
 *
 * Reads and writes go through `shared/utils/storage`, so a disabled or full
 * localStorage never throws — a reader falls back to its empty default and a
 * writer does nothing. Decoding the JSON, and deleting the stale v1 fold key
 * (the shared module offers no delete), are this module's own and carry their
 * own guards.
 */

import { readStorage, writeStorage } from '../shared/utils/storage';

/** Storage key for the active topologies in the user's drag order. */
const ORDER_KEY = 'newspack-nodes:overview:order';

/** Storage key for the topology names whose rows are UNFOLDED. */
const EXPANDED_KEY = 'newspack-nodes:overview:expanded';

/**
 * Storage key for the within-tree entity keys that are FOLDED shut.
 *
 * A fold key is rooted at its topology (`firehose>completed`), and the `:v2`
 * suffix is what separates it from the unrooted keys sitting under
 * `COLLAPSED_KEY_V1`.
 */
const COLLAPSED_KEY = 'newspack-nodes:overview:collapsed:v2';

/** The unrooted fold key `COLLAPSED_KEY` replaces; `readCollapsed` deletes it. */
const COLLAPSED_KEY_V1 = 'newspack-nodes:overview:collapsed';

/**
 * Read and decode a JSON string-array from storage.
 *
 * Overview hands the exported readers straight to `useState`, so a throw here
 * would take down the dashboard's first paint. A payload that is absent,
 * unparseable or not an array therefore yields [], costing the user the
 * remembered layout and nothing else.
 *
 * @param {string} key Storage key to read.
 * @return {string[]} The decoded array, or [] when the payload is unusable.
 */
function readStringArray( key ) {
	const raw = readStorage( key );
	if ( null === raw ) {
		return [];
	}
	try {
		const parsed = JSON.parse( raw );
		return Array.isArray( parsed ) ? parsed : [];
	} catch ( _err ) {
		return [];
	}
}

/**
 * Encode a string-array as JSON and store it.
 *
 * @param {string}   key   Storage key to write.
 * @param {string[]} names Values to store.
 */
function writeStringArray( key, names ) {
	writeStorage( key, JSON.stringify( names ) );
}

/**
 * Read the persisted drag order of the active topologies.
 *
 * @return {string[]} The stored order, or [] when nothing usable is stored.
 */
export function readOrder() {
	return readStringArray( ORDER_KEY );
}

/**
 * Persist the drag order of the active topologies.
 *
 * @param {string[]} names Topology names, in display order.
 */
export function writeOrder( names ) {
	writeStringArray( ORDER_KEY, names );
}

/**
 * Read the set of UNFOLDED topology names.
 *
 * @return {Set<string>} The unfolded names, empty when nothing usable is
 *                       stored — which is the fully folded board.
 */
export function readExpanded() {
	return new Set( readStringArray( EXPANDED_KEY ) );
}

/**
 * Persist the set of UNFOLDED topology names, stored as a JSON array.
 *
 * @param {Set<string>} set The unfolded topology names.
 */
export function writeExpanded( set ) {
	writeStringArray( EXPANDED_KEY, [ ...set ] );
}

/**
 * Read the set of FOLDED within-tree entity keys — the node and partition
 * folds inside one topology's tree, distinct from the topology-level fold
 * above.
 *
 * Every fold key is rooted at its topology, so an entry under the unrooted v1
 * key names no entity the tree draws. Reading deletes that key outright rather
 * than leaving a payload nothing will ever match.
 *
 * @return {Set<string>} The folded entity keys, empty when nothing usable is
 *                       stored.
 */
export function readCollapsed() {
	try {
		window.localStorage.removeItem( COLLAPSED_KEY_V1 );
	} catch ( _err ) {
		// localStorage disabled; nothing to drop.
	}
	return new Set( readStringArray( COLLAPSED_KEY ) );
}

/**
 * Persist the set of FOLDED within-tree entity keys, stored as a JSON array.
 *
 * @param {Set<string>} set The folded entity keys.
 */
export function writeCollapsed( set ) {
	writeStringArray( COLLAPSED_KEY, [ ...set ] );
}
