/* eslint-env jest */
/**
 * Set the page data a station load localizes, each context reading its
 * default layout as `tests/fixtures/station-layouts.json` holds it, which
 * PHPUnit holds to `Composition::validate()`.
 */

import LAYOUTS from '../../../tests/fixtures/station-layouts.json';

/**
 * Localize the station pages' data for a reader.
 *
 * @param {Object}  [reader]           Who reads the page.
 * @param {boolean} [reader.canTune]   Whether they may curate.
 * @param {boolean} [reader.canManage] Whether they are an operator.
 */
export function localizeStationPages( {
	canTune = false,
	canManage = false,
} = {} ) {
	window.NewspackNodesStationPages = {
		canTune,
		canManage,
		compositions: Object.fromEntries(
			Object.entries( LAYOUTS ).map( ( [ context, blocks ] ) => [
				context,
				{
					context,
					source: 'default',
					blocks,
					saved_ts: null,
					actor: null,
				},
			] )
		),
	};
}
