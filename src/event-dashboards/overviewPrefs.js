/**
 * overviewPrefs — localStorage persistence for the Overview tab's user-chosen
 * active-topology order and folded/unfolded state. Matches the usePanelChrome
 * try/catch idiom: a corrupt payload or a disabled/quota'd localStorage degrades
 * to the default (readers → [] / empty Set, writers → no-op) and never throws.
 */

const ORDER_KEY = 'newspack-nodes:overview:order';
const EXPANDED_KEY = 'newspack-nodes:overview:expanded';
const COLLAPSED_KEY = 'newspack-nodes:overview:collapsed';

// Read a JSON string-array from localStorage; anything not a clean array → [].
function readStringArray( key ) {
	try {
		const raw = window.localStorage.getItem( key );
		if ( null === raw ) {
			return [];
		}
		const parsed = JSON.parse( raw );
		return Array.isArray( parsed ) ? parsed : [];
	} catch ( _err ) {
		return [];
	}
}

// Persist a JSON string-array; disabled/quota'd storage is a silent no-op.
function writeStringArray( key, names ) {
	try {
		window.localStorage.setItem( key, JSON.stringify( names ) );
	} catch ( _err ) {
		// localStorage disabled/quota'd; in-session only.
	}
}

/**
 * Read the persisted active-topology order.
 *
 * @return {string[]} The stored order, or [] when absent/corrupt/disabled.
 */
export function readOrder() {
	return readStringArray( ORDER_KEY );
}

/**
 * Persist the active-topology order.
 *
 * @param {string[]} names The order to store.
 */
export function writeOrder( names ) {
	writeStringArray( ORDER_KEY, names );
}

/**
 * Read the persisted set of UNFOLDED topology names.
 *
 * @return {Set<string>} The stored set, or an empty Set when absent/corrupt/disabled.
 */
export function readExpanded() {
	return new Set( readStringArray( EXPANDED_KEY ) );
}

/**
 * Persist the set of UNFOLDED topology names (stored as a JSON array).
 *
 * @param {Set<string>} set The unfolded names.
 */
export function writeExpanded( set ) {
	writeStringArray( EXPANDED_KEY, [ ...set ] );
}

/**
 * Read the persisted set of COLLAPSED within-tree fold keys (the inner
 * node/partition folds, distinct from the topology-level unfold above).
 *
 * @return {Set<string>} The stored set, or an empty Set when absent/corrupt/disabled.
 */
export function readCollapsed() {
	return new Set( readStringArray( COLLAPSED_KEY ) );
}

/**
 * Persist the set of COLLAPSED within-tree fold keys (stored as a JSON array).
 *
 * @param {Set<string>} set The collapsed fold keys.
 */
export function writeCollapsed( set ) {
	writeStringArray( COLLAPSED_KEY, [ ...set ] );
}
