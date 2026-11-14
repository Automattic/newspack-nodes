/* eslint-env jest */
/**
 * The Aggregator layout editor's bundle mounts the localized composition's
 * editor against this bundle's block views, on import.
 */

const mockViews = { 'newspack-nodes/okarito-7871': { View: () => null } };
jest.mock( '../aggregatorSources', () => ( { BLOCK_VIEWS: mockViews } ) );
jest.mock( '../../station/stationEditor', () => ( {
	mountStationEditor: jest.fn(),
} ) );

import { mountStationEditor } from '../../station/stationEditor';

it( 'mounts the station editor on the localized composition and this bundle’s views', () => {
	const localized = {
		context: 'newspack-nodes/station-okarito-7871',
		blocks: {},
		patterns: [],
		inline: [],
	};
	window.NewspackNodesComposition = localized;
	require( '../layout-editor' );
	expect( mountStationEditor ).toHaveBeenCalledTimes( 1 );
	expect( mountStationEditor ).toHaveBeenCalledWith( localized, mockViews );
} );
