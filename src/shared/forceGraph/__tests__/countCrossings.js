/**
 * Test instrument: how many pairs of spans cross.
 */

import { crosses } from '../untangle';

/**
 * Count the pairs of spans that cross.
 *
 * @param {import('../model').Link[]} spans Spans between leaves.
 * @return {number} Crossing pairs.
 */
export const countCrossings = ( spans ) => {
	let count = 0;
	for ( let i = 0; i < spans.length; i++ ) {
		for ( let j = i + 1; j < spans.length; j++ ) {
			if ( crosses( spans[ i ], spans[ j ] ) ) {
				count++;
			}
		}
	}
	return count;
};
