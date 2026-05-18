/**
 * Tests for the substrate-side CommandClient singleton factory used by the
 * topology console's M4 hooks. Mirrors the app-side helper in
 * `newspack-event-logger-nodes/src/shared/utils/commandClient.js` but lives
 * here because the substrate has no dependency on the application repo.
 */

import {
	getCommandClient,
	__resetCommandClientForTests,
} from '../commandClient';

describe( 'getCommandClient', () => {
	afterEach( () => {
		__resetCommandClientForTests();
		delete window.NewspackNodesData;
	} );

	it( 'returns the same instance on repeat calls', () => {
		window.NewspackNodesData = {
			restUrl: '/wp-json/',
			nonce: 'abc123',
		};
		const a = getCommandClient();
		const b = getCommandClient();
		expect( a ).toBe( b );
	} );

	it( 'constructs with baseUrl + nonce from window.NewspackNodesData', () => {
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'NONCE',
		};
		const client = getCommandClient();
		expect( client.baseUrl ).toBe( 'https://example.test/wp-json/' );
		expect( client.nonce ).toBe( 'NONCE' );
	} );

	it( 'falls back to safe defaults when NewspackNodesData is missing', () => {
		const client = getCommandClient();
		expect( client.baseUrl ).toBe( '/wp-json/' );
		expect( client.nonce ).toBe( '' );
	} );
} );
