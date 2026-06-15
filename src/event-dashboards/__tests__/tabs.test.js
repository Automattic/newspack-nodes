/**
 * tabs.js registers the hub DevTools tabs the event-dashboards bundle owns:
 * the Topology Manager (order 10) and Raw Logs (order 20). Importing the module
 * (for its side effect) must put both tabs in the shared registry under host 'hub'.
 */

import { __ } from '@wordpress/i18n';

// RawLogs pulls in the whole rawlogs node graph; the registry only stores the
// component reference, so a stub keeps this a pure registry test.
jest.mock( '../RawLogs', () => () => null );

test( 'importing tabs registers the topology-manager tab on the hub host', () => {
	const { getDevtoolsTabs } = require( '../../shared/devtools/tabRegistry' );
	require( '../tabs' );
	const hubTabs = getDevtoolsTabs( 'hub' );
	const tab = hubTabs.find( ( t ) => t.id === 'topology-manager' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( typeof tab.component ).toBe( 'function' );
} );

test( 'importing tabs registers the raw-logs tab on the hub host at order 20, full-bleed', () => {
	// tabs.js was already required by the first test; re-run its side effect.
	jest.resetModules();
	require( '../tabs' );
	const { getDevtoolsTabs } = require( '../../shared/devtools/tabRegistry' );
	const hubTabs = getDevtoolsTabs( 'hub' );
	const tab = hubTabs.find( ( t ) => t.id === 'raw-logs' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( tab.order ).toBe( 20 );
	expect( tab.fullBleed ).toBe( true );
	expect( tab.label ).toBe( __( 'Raw Logs', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );
