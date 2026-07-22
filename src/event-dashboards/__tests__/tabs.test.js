/**
 * tabs.js registers the hub DevTools tabs the event-dashboards bundle owns:
 * the Overview landing (order 0 — the default first paint, now folding in the
 * old Topologies tab's per-topology detail tree) and Partition Viewer (order 20).
 * Importing the module (for its side effect) must put them in the shared
 * registry under host 'hub'.
 */

import { __ } from '@wordpress/i18n';

// The tab components pull in heavy trees; stubs keep this a pure registry test.
jest.mock( '../PartitionViewer', () => () => null );
jest.mock( '../LogViewer', () => () => null );
jest.mock( '../ConfigAudit', () => () => null );
jest.mock( '../Overview', () => () => null );
jest.mock( '../Jobs', () => () => null );

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

test( 'importing tabs registers the Jobs tab on the hub host between Overview and Partition Viewer', () => {
	// resetModules forces tabs.js to re-run its registration side effect.
	jest.resetModules();
	require( '../tabs' );
	const { getDevtoolsTabs } = require( '../../shared/devtools/tabRegistry' );
	const hubTabs = getDevtoolsTabs( 'hub' );
	const tab = hubTabs.find( ( t ) => t.id === 'jobs' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( tab.slug ).toBe( 'jobs' );
	expect( tab.order ).toBeGreaterThan( 0 ); // after Overview
	expect( tab.order ).toBeLessThan( 20 ); // before Partition Viewer
	expect( tab.label ).toBe( __( 'Jobs', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );

test( 'importing tabs registers the partition-viewer tab on the hub host at order 20, full-bleed', () => {
	// tabs.js was already required by the first test; re-run its side effect.
	jest.resetModules();
	require( '../tabs' );
	const { getDevtoolsTabs } = require( '../../shared/devtools/tabRegistry' );
	const hubTabs = getDevtoolsTabs( 'hub' );
	const tab = hubTabs.find( ( t ) => t.id === 'partition-viewer' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( tab.order ).toBe( 20 );
	expect( tab.fullBleed ).toBe( true );
	expect( tab.label ).toBe( __( 'Partition Viewer', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );

test( 'importing tabs registers the log-viewer tab (order 25, full-bleed, ?source=)', () => {
	jest.resetModules();
	require( '../tabs' );
	const { getDevtoolsTabs } = require( '../../shared/devtools/tabRegistry' );
	const tab = getDevtoolsTabs( 'hub' ).find( ( t ) => t.id === 'log-viewer' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( tab.slug ).toBe( 'log-viewer' );
	expect( tab.param ).toBe( 'source' );
	expect( tab.order ).toBe( 25 );
	expect( tab.fullBleed ).toBe( true );
	expect( tab.label ).toBe( __( 'Log Viewer', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );

test( 'importing tabs registers the config-audit tab on the hub host at order 30', () => {
	jest.resetModules();
	require( '../tabs' );
	const { getDevtoolsTabs } = require( '../../shared/devtools/tabRegistry' );
	const tab = getDevtoolsTabs( 'hub' ).find(
		( t ) => t.id === 'config-audit'
	);
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( tab.slug ).toBe( 'config-audit' );
	expect( tab.order ).toBe( 30 );
	expect( tab.order ).toBeGreaterThan( 25 ); // after the Log Viewer
	expect( tab.label ).toBe( __( 'Config Audit', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );
