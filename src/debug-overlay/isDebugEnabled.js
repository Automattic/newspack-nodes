const KEY = 'newspack-nodes:debug';

/**
 * Whether the debug overlay should mount. `?nodes-debug=1` turns it on and
 * sticks (localStorage) so it survives navigation; `?nodes-debug=0` turns it
 * off and clears the sticky flag. Absent the param, the sticky flag decides.
 * A pure dev affordance — no capability/PHP gate.
 *
 * @param {string} [search] window.location.search (injectable for tests).
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
