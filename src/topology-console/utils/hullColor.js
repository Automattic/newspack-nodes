/**
 * The color of an include's hull, which both canvases paint alike.
 */

import { nameHash } from '../../shared/hooks/useTimeChart';

/**
 * How many hull colour classes exist, mirroring `@for $i from 0 through 5` in
 * _force-graph.scss. An index past the end paints an unstyled hull.
 */
const HULL_COLORS = 6;

/**
 * The colour class for one include's hull, hashed from the include name so the
 * colour holds still. Colouring by paint order would reshuffle every hull the
 * moment a drag changed the area sort the paths are drawn in.
 *
 * @param {string} include Include name.
 * @return {number} An index in `[0, HULL_COLORS)`.
 */
export function hullColorIndex( include ) {
	return nameHash( include ) % HULL_COLORS;
}
