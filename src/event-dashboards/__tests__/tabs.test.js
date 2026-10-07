/**
 * tabs.js registers the station tabs the event-dashboards bundle owns:
 * the Overview landing (order 0 — the default first paint, now folding in the
 * old Topologies tab's per-topology detail tree) and Log Viewer (order 20).
 * Importing the module (for its side effect) must put them in the shared
 * registry under host 'station'.
 */

import { __ } from '@wordpress/i18n';

// The tab components pull in heavy trees; stubs keep this a pure registry test.
jest.mock( '../LogViewer', () => () => null );
jest.mock( '../ConfigAudit', () => () => null );
jest.mock( '../Overview', () => () => null );
jest.mock( '../Jobs', () => () => null );
jest.mock( '../Tables', () => () => null );

test( 'importing tabs registers the overview tab first (order 0) on the station host', () => {
	const { getTabs, resetTabs } = require( '../../shared/tabs/tabRegistry' );
	resetTabs();
	require( '../tabs' );
	const stationTabs = getTabs( 'station' );
	const tab = stationTabs.find( ( t ) => t.id === 'overview' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'station' );
	expect( tab.order ).toBe( 0 );
	expect( tab.label ).toBe( __( 'Overview', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
	// Order 0 → it sorts ahead of the other event-dashboards tabs.
	expect( stationTabs[ 0 ].id ).toBe( 'overview' );
} );

test( 'importing tabs no longer registers a separate topology-manager tab (merged into Overview)', () => {
	const { getTabs, resetTabs } = require( '../../shared/tabs/tabRegistry' );
	resetTabs();
	require( '../tabs' );
	const stationTabs = getTabs( 'station' );
	expect(
		stationTabs.find( ( t ) => t.id === 'topology-manager' )
	).toBeUndefined();
} );

test( 'importing tabs registers the Jobs tab on the station host between Overview and Log Viewer', () => {
	// resetModules forces tabs.js to re-run its registration side effect.
	jest.resetModules();
	require( '../tabs' );
	const { getTabs } = require( '../../shared/tabs/tabRegistry' );
	const stationTabs = getTabs( 'station' );
	const tab = stationTabs.find( ( t ) => t.id === 'jobs' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'station' );
	expect( tab.slug ).toBe( 'jobs' );
	expect( tab.order ).toBeGreaterThan( 0 ); // after Overview
	expect( tab.order ).toBeLessThan( 20 ); // before Log Viewer
	expect( tab.label ).toBe( __( 'Jobs', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );

test( 'importing tabs registers the log-viewer tab on the station host at order 20, full-bleed, ?log=', () => {
	// tabs.js was already required by the first test; re-run its side effect.
	jest.resetModules();
	require( '../tabs' );
	const { getTabs } = require( '../../shared/tabs/tabRegistry' );
	const stationTabs = getTabs( 'station' );
	const tab = stationTabs.find( ( t ) => t.id === 'log-viewer' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'station' );
	expect( tab.slug ).toBe( 'log-viewer' );
	expect( tab.param ).toBe( 'log' );
	expect( tab.order ).toBe( 20 );
	expect( tab.fullBleed ).toBe( true );
	expect( tab.label ).toBe( __( 'Log Viewer', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
	expect(
		stationTabs.find( ( t ) => t.id === 'partition-viewer' )
	).toBeUndefined();
} );

test( 'importing tabs registers the config-audit tab on the station host at order 30', () => {
	jest.resetModules();
	require( '../tabs' );
	const { getTabs } = require( '../../shared/tabs/tabRegistry' );
	const tab = getTabs( 'station' ).find( ( t ) => t.id === 'config-audit' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'station' );
	expect( tab.slug ).toBe( 'config-audit' );
	expect( tab.order ).toBe( 30 );
	expect( tab.order ).toBeGreaterThan( 20 ); // after the Log Viewer
	expect( tab.label ).toBe( __( 'Config Audit', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );

test( 'importing tabs registers the Tables tab on the station host after Jobs and before Log Viewer', () => {
	jest.resetModules();
	require( '../tabs' );
	const { getTabs } = require( '../../shared/tabs/tabRegistry' );
	const stationTabs = getTabs( 'station' );
	const tab = stationTabs.find( ( t ) => t.id === 'tables' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'station' );
	expect( tab.slug ).toBe( 'tables' );
	expect( tab.order ).toBe( 12 );
	expect( tab.label ).toBe( __( 'Tables', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
	const ids = stationTabs.map( ( t ) => t.id );
	expect( ids.indexOf( 'tables' ) ).toBe( ids.indexOf( 'jobs' ) + 1 );
	expect( ids.indexOf( 'tables' ) ).toBeLessThan(
		ids.indexOf( 'log-viewer' )
	);
} );
