/**
 * tabs.js registers the Sessions hub DevTools tab. Importing the module for its
 * side effect must put it in the shared registry under host 'hub'.
 */

import { __ } from '@wordpress/i18n';

jest.mock( '../SessionsAdmin', () => () => null );

test( 'importing tabs registers the sessions tab on the hub host', () => {
	const { getDevtoolsTabs } = require( '../../shared/devtools/tabRegistry' );
	require( '../tabs' );
	const tab = getDevtoolsTabs( 'hub' ).find( ( t ) => t.id === 'sessions' );
	expect( tab ).toBeTruthy();
	expect( tab.host ).toBe( 'hub' );
	expect( tab.slug ).toBe( 'sessions' );
	expect( tab.order ).toBe( 35 );
	expect( tab.label ).toBe( __( 'Sessions', 'newspack-nodes' ) );
	expect( typeof tab.component ).toBe( 'function' );
} );
