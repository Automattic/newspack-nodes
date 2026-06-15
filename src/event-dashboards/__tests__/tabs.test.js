/**
 * tabs.js registers the Topology Manager as a `host: 'hub'` DevTools tab.
 * Importing the module (for its side effect) must put the tab in the shared
 * registry under host 'hub'.
 */

test( 'importing tabs registers the topology-manager tab on the hub host', () => {
	const { getDevtoolsTabs } = require( '../../shared/devtools/tabRegistry' );
	require( '../tabs' );
	const hubTabs = getDevtoolsTabs( 'hub' );
	const tab = hubTabs.find( ( t ) => t.id === 'topology-manager' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( typeof tab.component ).toBe( 'function' );
} );
