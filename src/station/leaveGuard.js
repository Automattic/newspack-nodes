/**
 * The station tabs' leave guard: each station tab's descriptor declares
 * `beforeStationLeave` as its `beforeLeave`, and the one layout mounted
 * answers it through `guardLeave()` while its editor holds a change. The
 * host mounts one tab at a time, so one answer stands at most. The answer
 * lives on the page's pop record, so every bundle's copy of this module
 * reads the one a layout in any bundle set.
 */
import { leaveGuards } from '@newspack-nodes/shared/utils/queryParams';

/** The key the station's answer stands under. */
const STATION = 'station';

/**
 * Answer the station tab's `beforeLeave` until the returned release runs.
 *
 * @param {(next: import('@newspack-nodes/shared/tabs/tabRegistry').TabLeave) => boolean} guard What a switch is told.
 * @return {() => void} Withdraws the answer.
 */
export function guardLeave( guard ) {
	leaveGuards()[ STATION ] = guard;
	return () => {
		const guards = leaveGuards();
		if ( guards[ STATION ] === guard ) {
			delete guards[ STATION ];
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
	const answer = leaveGuards()[ STATION ];
	return answer ? answer( next ) : true;
}
