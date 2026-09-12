/**
 * tabs.js registers the Topology Console as a `host: 'station'` tab at
 * order 15 (after the Topology Manager at order 5, which follows the Overview
 * landing at order 0). Importing the module (for its side effect) must put the
 * tab in the shared registry under host 'station'.
 */

import { __ } from '@wordpress/i18n';

// A stub keeps this a pure registry test (the real console pulls the graph).
jest.mock( '../TopologyConsole', () => () => null );

test( 'importing tabs registers the topology-console tab on the station host at order 15', () => {
	const { getTabs, resetTabs } = require( '../../shared/tabs/tabRegistry' );
	resetTabs();
	require( '../tabs' );
	const stationTabs = getTabs( 'station' );
	const tab = stationTabs.find( ( t ) => t.id === 'topology-console' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'station' );
	expect( tab.order ).toBe( 15 );
	expect( tab.label ).toBe( __( 'Console', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );
