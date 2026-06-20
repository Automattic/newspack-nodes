/**
 * tabs.js registers the Topology Console as a `host: 'hub'` DevTools tab at
 * order 5 (after the Overview landing at order 0, before the Topology Manager at
 * order 10). Importing the module (for its side effect) must put the tab in the
 * shared registry under host 'hub'.
 */

import { __ } from '@wordpress/i18n';

// The real TopologyConsole pulls in the whole console graph; the registry only
// stores the component reference, so a stub keeps this a pure registry test.
jest.mock( '../TopologyConsole', () => () => null );

test( 'importing tabs registers the topology-console tab on the hub host at order 5', () => {
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
	expect( tab.order ).toBe( 5 );
	expect( tab.label ).toBe( __( 'Console', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );
