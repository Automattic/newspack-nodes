/**
 * The DataViews entry publishes the package as `window.newspackNodesDataViews`,
 * the global every consumer's build reads `@wordpress/dataviews` from.
 */

import * as dataviews from '@wordpress/dataviews';

describe( 'the DataViews entry', () => {
	it( 'publishes the whole package as the substrate global', () => {
		delete window.newspackNodesDataViews;
		require( '../index.js' );
		expect( window.newspackNodesDataViews.DataViews ).toBe(
			dataviews.DataViews
		);
		expect( Object.keys( window.newspackNodesDataViews ).sort() ).toEqual(
			Object.keys( dataviews ).sort()
		);
	} );
} );
