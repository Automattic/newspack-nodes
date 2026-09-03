/**
 * The debug overlay's gate. `DebugOverlay` renders nothing unless this says
 * yes, so a dashboard ships the overlay mounted and dormant: invisible to a
 * normal visitor, one query parameter away for whoever is debugging it.
 *
 * The gate is a dev affordance, not an access control. It has no capability
 * check and no PHP counterpart, because it decides only whether the FAB and
 * panel appear over a page the visitor has already been served; the REST
 * command endpoint authorizes whatever the overlay's REPL then sends.
 */

/**
 * localStorage key for the sticky flag. Fixed, never per-dashboard: turning
 * debug on anywhere turns it on everywhere, which is what surviving navigation
 * means. `DebugOverlay`'s identically-named `storageKey` default is a
 * different key — it is read only with a suffix, so the two never collide.
 */
const KEY = 'newspack-nodes:debug';

/**
 * Decides whether the debug overlay mounts, and persists the query parameter's
 * answer on the way through. `?nodes-debug=1` turns the overlay on and stores
 * the sticky flag so it survives navigation; `?nodes-debug=0` turns it off and
 * removes the flag, so off is the key's absence rather than a stored `'0'`.
 * Absent the parameter, the stored flag decides.
 *
 * The name reads as a predicate and the call writes: one call from the render
 * path both applies the parameter and makes it stick, which leaves no separate
 * enable step for a caller to forget.
 *
 * Whatever URLSearchParams refuses to parse counts as no parameter. A
 * localStorage that throws — disabled, or blocked by the browser — leaves the
 * parameter deciding alone, so debug lasts that one page load.
 *
 * @param {string} [search] window.location.search, injectable for tests.
 * @return {boolean} Whether the debug overlay should mount.
 */
export function isDebugEnabled( search = window.location.search ) {
	let param = null;
	try {
		param = new URLSearchParams( search ).get( 'nodes-debug' );
	} catch ( _e ) {
		param = null;
	}
	try {
		if ( param === '1' ) {
			window.localStorage.setItem( KEY, '1' );
			return true;
		}
		if ( param === '0' ) {
			window.localStorage.removeItem( KEY );
			return false;
		}
		return window.localStorage.getItem( KEY ) === '1';
	} catch ( _e ) {
		// localStorage disabled — honor the param alone.
		return param === '1';
	}
}
