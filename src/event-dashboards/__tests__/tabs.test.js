/**
 * tabs.js registers the hub DevTools tabs the event-dashboards bundle owns:
 * the Overview landing (order 0 — the default first paint, now folding in the
 * old Topologies tab's per-topology detail tree) and Raw Logs (order 20).
 * Importing the module (for its side effect) must put them in the shared
 * registry under host 'hub'.
 */

import { __ } from '@wordpress/i18n';

// RawLogs + Overview pull in dashboard graph/hook trees; the registry only stores
// the component reference, so stubs keep this a pure registry test.
jest.mock( '../RawLogs', () => () => null );
jest.mock( '../Overview', () => () => null );

test( 'importing tabs registers the overview tab first (order 0) on the hub host', () => {
	const {
		getDevtoolsTabs,
		resetDevtoolsTabs,
	} = require( '../../shared/devtools/tabRegistry' );
	resetDevtoolsTabs();
	require( '../tabs' );
	const hubTabs = getDevtoolsTabs( 'hub' );
	const tab = hubTabs.find( ( t ) => t.id === 'overview' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( tab.order ).toBe( 0 );
	expect( tab.label ).toBe( __( 'Overview', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
	// Order 0 → it sorts ahead of the other event-dashboards tabs.
	expect( hubTabs[ 0 ].id ).toBe( 'overview' );
} );

test( 'importing tabs no longer registers a separate topology-manager tab (merged into Overview)', () => {
	const {
		getDevtoolsTabs,
		resetDevtoolsTabs,
	} = require( '../../shared/devtools/tabRegistry' );
	resetDevtoolsTabs();
	require( '../tabs' );
	const hubTabs = getDevtoolsTabs( 'hub' );
	expect(
		hubTabs.find( ( t ) => t.id === 'topology-manager' )
	).toBeUndefined();
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
