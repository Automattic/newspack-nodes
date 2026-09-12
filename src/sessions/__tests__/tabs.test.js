/**
 * tabs.js registers the Sessions station tab. Importing the module for its
 * side effect must put it in the shared registry under host 'station'.
 */

import { __ } from '@wordpress/i18n';

jest.mock( '../SessionsAdmin', () => () => null );

test( 'importing tabs registers the sessions tab on the station host', () => {
	const { getTabs } = require( '../../shared/tabs/tabRegistry' );
	require( '../tabs' );
	const tab = getTabs( 'station' ).find( ( t ) => t.id === 'sessions' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'station' );
	expect( tab.slug ).toBe( 'sessions' );
	expect( tab.order ).toBe( 35 );
	expect( tab.label ).toBe( __( 'Sessions', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );
