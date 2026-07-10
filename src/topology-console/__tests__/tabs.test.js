/**
 * tabs.js registers the Topology Console as a `host: 'hub'` DevTools tab at
 * order 15 (after the Topology Manager at order 5, which follows the Overview
 * landing at order 0). Importing the module (for its side effect) must put the
 * tab in the shared registry under host 'hub'.
 */

import { __ } from '@wordpress/i18n';

// A stub keeps this a pure registry test (the real console pulls the graph).
jest.mock( '../TopologyConsole', () => () => null );

test( 'importing tabs registers the topology-console tab on the hub host at order 15', () => {
	const {
		getDevtoolsTabs,
		resetDevtoolsTabs,
	} = require( '../../shared/devtools/tabRegistry' );
	resetDevtoolsTabs();
	require( '../tabs' );
	const hubTabs = getDevtoolsTabs( 'hub' );
	const tab = hubTabs.find( ( t ) => t.id === 'topology-console' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( tab.order ).toBe( 15 );
	expect( tab.label ).toBe( __( 'Console', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );
