/**
 * CommandClient.fromGlobal — builds a CommandClient from the PHP-localized
 * `window.NewspackNodesData` (REST base + command nonce). The push-side boundary
 * nodes (HttpOut) lazily default their client to this so a fresh palette-drop
 * never needs the nonce threaded through construction args.
 */

import { CommandClient } from '../command-client';

describe( 'CommandClient.fromGlobal', () => {
	afterEach( () => {
		delete window.NewspackNodesData;
	} );

	it( 'builds a CommandClient with the localized restUrl + nonce', () => {
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'GNONCE',
		};
		const client = CommandClient.fromGlobal();
		expect( client ).toBeInstanceOf( CommandClient );
		expect( client.baseUrl ).toBe( 'https://example.test/wp-json/' );
		expect( client.nonce ).toBe( 'GNONCE' );
	} );

	it( 'falls back to the safe REST default when the global is absent', () => {
		delete window.NewspackNodesData;
		const client = CommandClient.fromGlobal();
		expect( client.baseUrl ).toBe( '/wp-json/' );
		expect( client.nonce ).toBe( '' );
	} );
} );
