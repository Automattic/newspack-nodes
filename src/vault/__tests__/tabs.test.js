/**
 * tabs.js registers the Vault hub DevTools tab (order 30). Importing the module
 * (for its side effect) must put the tab in the shared registry under host 'hub'.
 */

import { __ } from '@wordpress/i18n';

// VaultAdmin pulls in the whole vault node graph; the registry only stores the
// component reference, so a stub keeps this a pure registry test.
jest.mock( '../VaultAdmin', () => () => null );

test( 'importing tabs registers the vault tab on the hub host at order 30', () => {
	const { getDevtoolsTabs } = require( '../../shared/devtools/tabRegistry' );
	require( '../tabs' );
	const hubTabs = getDevtoolsTabs( 'hub' );
	const tab = hubTabs.find( ( t ) => t.id === 'vault' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( tab.order ).toBe( 30 );
	expect( tab.slug ).toBe( 'vault' );
	expect( tab.label ).toBe( __( 'Vault', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );
