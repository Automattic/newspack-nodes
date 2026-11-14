/**
 * StationLayout — one station tab as a composed page, on the shared
 * `ComposedPageFrame`: the tab's controls and chrome over the layout its
 * context reads, Edit layout for a `tune` reader, and while the editor holds
 * a change a tab switch asks first, through the station's leave guard.
 *
 * Each tab's bundle renders this with its own views, so the providers and
 * the blocks come from that one bundle.
 */

import ComposedPageFrame from '@newspack-nodes/shared/composition/page/ComposedPageFrame';
import { guardLeave } from './leaveGuard';
import {
	STATION_GROUP,
	STATION_PAGES,
	stationContext,
	stationPages,
} from './stationPages';

/**
 * @param {Object}                                                                                           props
 * @param {string}                                                                                           props.page                 A STATION_PAGES key.
 * @param {Object<string,import('@newspack-nodes/shared/composition/CompositionView').CompositionBlockView>} props.views                Every block's view.
 * @param {?Element}                                                                                         [props.headerControlsSlot] The station header's slot; null withholds the controls, undefined renders them inline.
 * @param {import('react').ReactNode}                                                                        [props.controls]           The tab's own header controls.
 * @param {import('react').ReactNode}                                                                        [props.children]           The chrome above the layout.
 * @return {import('react').ReactElement} The tab.
 */
export default function StationLayout( {
	page,
	views,
	headerControlsSlot,
	controls = null,
	children = null,
} ) {
	const { canTune, canManage, compositions } = stationPages();
	const context = stationContext( page );
	return (
		<ComposedPageFrame
			context={ context }
			page={ page }
			pages={ STATION_PAGES }
			group={ STATION_GROUP }
			canTune={ canTune }
			canManage={ canManage }
			layout={ compositions[ context ] }
			views={ views }
			headerControlsSlot={ headerControlsSlot }
			controls={ controls }
			guardLeave={ guardLeave }
		>
			{ children }
		</ComposedPageFrame>
	);
}
