/**
 * nodesData — reads the PHP-localized `window.NewspackNodesData` (REST base +
 * command nonce) with safe defaults. The nonce is request-scoped, so it lives
 * in this per-page global rather than in a node's make_node arguments.
 */

import apiFetch from '@wordpress/api-fetch';
import { nodesData, refreshNodesNonce } from '../nodes-data';

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

describe( 'refreshNodesNonce', () => {
	const NONCE_ENDPOINT =
		'https://example.test/wp-admin/admin-ajax.php?action=rest-nonce';
	let previousEndpoint;
	let previousMiddleware;

	beforeEach( () => {
		previousEndpoint = apiFetch.nonceEndpoint;
		previousMiddleware = apiFetch.nonceMiddleware;
		apiFetch.nonceEndpoint = NONCE_ENDPOINT;
		apiFetch.nonceMiddleware = { nonce: 'STALE-914' };
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'STALE-914',
		};
	} );

	afterEach( () => {
		delete global.fetch;
		delete window.NewspackNodesData;
		apiFetch.nonceEndpoint = previousEndpoint;
		apiFetch.nonceMiddleware = previousMiddleware;
	} );

	it( 'fetches, trims, and propagates a fresh nonce to the global and middleware', async () => {
		global.fetch = jest.fn().mockResolvedValue( {
			ok: true,
			text: () => Promise.resolve( '  FRESH-NONCE-DATA-771  ' ),
		} );

		await expect( refreshNodesNonce() ).resolves.toBe(
			'FRESH-NONCE-DATA-771'
		);

		expect( global.fetch ).toHaveBeenCalledWith( NONCE_ENDPOINT, {
			credentials: 'include',
		} );
		expect( window.NewspackNodesData.nonce ).toBe( 'FRESH-NONCE-DATA-771' );
		expect( apiFetch.nonceMiddleware.nonce ).toBe( 'FRESH-NONCE-DATA-771' );
	} );

	it( 'still resolves when apiFetch has no nonceMiddleware to update', async () => {
		apiFetch.nonceMiddleware = undefined;
		global.fetch = jest.fn().mockResolvedValue( {
			ok: true,
			text: () => Promise.resolve( 'FRESH-NO-MW-338' ),
		} );

		await expect( refreshNodesNonce() ).resolves.toBe( 'FRESH-NO-MW-338' );
		expect( window.NewspackNodesData.nonce ).toBe( 'FRESH-NO-MW-338' );
	} );

	it( 'shares one in-flight request across concurrent callers', async () => {
		let resolveFetch;
		global.fetch = jest.fn().mockReturnValue(
			new Promise( ( resolve ) => {
				resolveFetch = resolve;
			} )
		);

		const first = refreshNodesNonce();
		const second = refreshNodesNonce();
		expect( second ).toBe( first );
		expect( global.fetch ).toHaveBeenCalledTimes( 1 );

		resolveFetch( {
			ok: true,
			text: () => Promise.resolve( 'FRESH-SHARED-552' ),
		} );
		await expect( first ).resolves.toBe( 'FRESH-SHARED-552' );
	} );

	it( 'rejects when the REST nonce endpoint is unavailable', async () => {
		apiFetch.nonceEndpoint = undefined;
		global.fetch = jest.fn();

		await expect( refreshNodesNonce() ).rejects.toThrow(
			'REST nonce endpoint is unavailable'
		);
		expect( global.fetch ).not.toHaveBeenCalled();
	} );

	it( 'rejects when the localized global is absent', async () => {
		delete window.NewspackNodesData;
		global.fetch = jest.fn();

		await expect( refreshNodesNonce() ).rejects.toThrow(
			'NewspackNodesData is unavailable'
		);
		expect( global.fetch ).not.toHaveBeenCalled();
	} );

	it( 'rejects on a non-OK HTTP response', async () => {
		global.fetch = jest.fn().mockResolvedValue( {
			ok: false,
			status: 503,
			text: () => Promise.resolve( '' ),
		} );

		await expect( refreshNodesNonce() ).rejects.toThrow(
			'renewal failed with HTTP 503'
		);
	} );

	it( 'rejects when the endpoint returns the -1 no-nonce sentinel', async () => {
		global.fetch = jest.fn().mockResolvedValue( {
			ok: true,
			text: () => Promise.resolve( '-1' ),
		} );

		await expect( refreshNodesNonce() ).rejects.toThrow(
			'returned no nonce'
		);
	} );

	it( 'rejects when the endpoint returns an empty body', async () => {
		global.fetch = jest.fn().mockResolvedValue( {
			ok: true,
			text: () => Promise.resolve( '   ' ),
		} );

		await expect( refreshNodesNonce() ).rejects.toThrow(
			'returned no nonce'
		);
	} );
} );
