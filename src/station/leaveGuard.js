/**
 * The station tabs' leave guard: each station tab's descriptor declares
 * `beforeStationLeave` as its `beforeLeave`, and the one layout mounted
 * answers it through `guardLeave()` while its editor holds a change. The
 * host mounts one tab at a time, so one answer stands at most.
 */

/** @type {?(next: import('@newspack-nodes/shared/tabs/tabRegistry').TabLeave) => boolean} */
let answer = null;

/**
 * Answer the station tab's `beforeLeave` until the returned release runs.
 *
 * @param {(next: import('@newspack-nodes/shared/tabs/tabRegistry').TabLeave) => boolean} guard What a switch is told.
 * @return {() => void} Withdraws the answer.
 */
export function guardLeave( guard ) {
	answer = guard;
	return () => {
		if ( answer === guard ) {
			answer = null;
		}
	};
}

/**
 * The station tabs' `beforeLeave`: the mounted layout's answer, else yes.
 *
 * @param {import('@newspack-nodes/shared/tabs/tabRegistry').TabLeave} next The switch asked for.
 * @return {boolean} Whether the tab may go now.
 */
export function beforeStationLeave( next ) {
	return answer ? answer( next ) : true;
}
