/**
 * mountStationEditor — a station page's layout editor, for the editor
 * bundle of the tab that draws the page's blocks: the localized context's
 * blocks against that bundle's views, under the page's own heading, on a
 * page sending for the station's group and offering no restore inside the
 * editor.
 *
 * The editor half: only a station editor bundle imports it.
 */

import { __ } from '@wordpress/i18n';
import { ComposedPage } from '@newspack-nodes/shared/composition/page';
import { mountComposedEditor } from '@newspack-nodes/shared/composition/page/mountComposedEditor';
import { STATION_GROUP, STATION_PAGES, stationContext } from './stationPages';

/** Each station page => the editor's heading. */
const HEADINGS = {
	'station-overview': () =>
		__( 'Edit the Overview layout', 'newspack-nodes' ),
	'station-jobs': () => __( 'Edit the Jobs layout', 'newspack-nodes' ),
	'station-tables': () => __( 'Edit the Tables layout', 'newspack-nodes' ),
	'station-aggregator': () =>
		__( 'Edit the Aggregator layout', 'newspack-nodes' ),
};

/** The page the editor's blocks stand on, which restores nothing. */
const EDITOR_PAGE = {
	group: STATION_GROUP,
	canTune: false,
	operator: false,
	onRestored: () => {},
};

/**
 * Mount the localized station context's editor.
 *
 * @param {import('@newspack-nodes/shared/composition/page/mountComposedEditor').LocalizedComposition}       localized What `Composition::editor()` localized.
 * @param {Object<string,import('@newspack-nodes/shared/composition/CompositionView').CompositionBlockView>} views     Every block's view.
 * @throws {Error} When the localized context lays out none of the station's pages.
 */
export function mountStationEditor( localized, views ) {
	const page = Object.keys( STATION_PAGES ).find(
		( one ) => stationContext( one ) === localized.context
	);
	if ( ! page ) {
		throw new Error( `no station page lays out ${ localized.context }` );
	}
	mountComposedEditor( localized, views, {
		heading: HEADINGS[ page ](),
		wrap: ( children ) => (
			<ComposedPage.Provider value={ EDITOR_PAGE }>
				{ children }
			</ComposedPage.Provider>
		),
	} );
}
