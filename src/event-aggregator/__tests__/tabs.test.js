/**
 * tabs.js registers the Aggregator hub DevTools tab (order 40). Importing the
 * module (for its side effect) must put the tab in the shared registry under
 * host 'hub'. Mirrors vault/__tests__/tabs.test.js.
 */

import { __ } from '@wordpress/i18n';

// Stub AggregatorStatus so this stays a pure registry test (ref only).
jest.mock( '../AggregatorStatus', () => () => null );

test( 'importing tabs registers the aggregator tab on the hub host at order 40', () => {
	const { getDevtoolsTabs } = require( '../../shared/devtools/tabRegistry' );
	require( '../tabs' );
	const hubTabs = getDevtoolsTabs( 'hub' );
	const tab = hubTabs.find( ( t ) => t.id === 'aggregator' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( tab.order ).toBe( 40 );
	expect( tab.slug ).toBe( 'aggregator' );
	expect( tab.label ).toBe( __( 'Aggregator', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );
