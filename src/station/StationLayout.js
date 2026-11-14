/**
 * StationLayout — one station tab as a composed page, on the shared
 * `ComposedPageFrame`: the tab's controls and chrome over the layout its
 * context reads, Edit layout for a `tune` reader, and while the editor holds
 * a change a tab switch asks first, through the station's leave guard.
 *
 * A station load inlines the layout of the tab it opens on alone; any other
 * tab reads its own through `compositions get` as it opens, its chrome
 * standing while the read is owed.
 *
 * Each tab's bundle renders this with its own views, so the providers and
 * the blocks come from that one bundle.
 */

import { useMemo } from '@wordpress/element';
import ComposedPageFrame from '@newspack-nodes/shared/composition/page/ComposedPageFrame';
import { useComposition } from '@newspack-nodes/shared/composition/useComposition';
import { guardLeave } from './leaveGuard';
import {
	STATION_GROUP,
	STATION_PAGES,
	stationContext,
	stationPages,
} from './stationPages';

/**
 * @typedef {Object} StationLayoutProps
 * @property {string}                                                                                           page                 A STATION_PAGES key.
 * @property {Object<string,import('@newspack-nodes/shared/composition/CompositionView').CompositionBlockView>} views                Every block's view.
 * @property {?Element}                                                                                         [headerControlsSlot] The station header's slot; null withholds the controls, undefined renders them inline.
 * @property {import('react').ReactNode}                                                                        [controls]           The tab's own header controls.
 * @property {import('react').ReactNode}                                                                        [children]           The chrome above the layout.
 */

/**
 * @param {StationLayoutProps} props
 * @return {import('react').ReactElement} The tab.
 */
export default function StationLayout( props ) {
	const inlined = stationPages().compositions[ stationContext( props.page ) ];
	return inlined ? (
		<StationFrame { ...props } layout={ inlined } />
	) : (
		<ReadStationFrame { ...props } />
	);
}

/**
 * A tab the load did not inline: its layout as `compositions get` answers
 * it, an empty one while the answer is owed, and a refusal in its place.
 *
 * @param {StationLayoutProps} props
 * @return {import('react').ReactElement} The tab.
 */
function ReadStationFrame( props ) {
	const context = stationContext( props.page );
	const { answer, error } = useComposition( STATION_GROUP, context );
	const owed = useMemo(
		() => ( {
			context,
			source: 'default',
			blocks: [],
			saved_ts: null,
			actor: null,
		} ),
		[ context ]
	);
	const refused = useMemo(
		() => ( error ? { context, error } : null ),
		[ context, error ]
	);
	return <StationFrame { ...props } layout={ answer ?? refused ?? owed } />;
}

/**
 * @param {StationLayoutProps & {layout: Object}} props
 * @return {import('react').ReactElement} The tab over `layout`.
 */
function StationFrame( {
	page,
	views,
	layout,
	headerControlsSlot,
	controls = null,
	children = null,
} ) {
	const { canTune, canManage } = stationPages();
	return (
		<ComposedPageFrame
			context={ stationContext( page ) }
			page={ page }
			pages={ STATION_PAGES }
			group={ STATION_GROUP }
			canTune={ canTune }
			canManage={ canManage }
			layout={ layout }
			views={ views }
			headerControlsSlot={ headerControlsSlot }
			controls={ controls }
			guardLeave={ guardLeave }
		>
			{ children }
		</ComposedPageFrame>
	);
}
