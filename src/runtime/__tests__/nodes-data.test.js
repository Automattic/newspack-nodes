/**
 * nodesData — reads the PHP-localized `window.NewspackNodesData` (REST base +
 * command nonce) with safe defaults. The nonce is request-scoped, so it lives
 * in this per-page global rather than in a node's make_node arguments.
 */

import { nodesData } from '../nodes-data';

describe( 'nodesData', () => {
	afterEach( () => {
		delete window.NewspackNodesData;
	} );

	it( 'reads restUrl and nonce from window.NewspackNodesData', () => {
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'N1',
		};
		expect( nodesData() ).toEqual( {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'N1',
		} );
	} );

	it( 'falls back to safe defaults when the global is absent', () => {
		delete window.NewspackNodesData;
		expect( nodesData() ).toEqual( { restUrl: '/wp-json/', nonce: '' } );
	} );

	it( 'defaults each field independently when the global is partial', () => {
		window.NewspackNodesData = { nonce: 'ONLYNONCE' };
		expect( nodesData() ).toEqual( {
			restUrl: '/wp-json/',
			nonce: 'ONLYNONCE',
		} );
	} );
} );
