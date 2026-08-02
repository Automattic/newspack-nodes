/**
 * CommandClient.fromGlobal — builds a CommandClient from the PHP-localized
 * `window.NewspackNodesData` (REST base + command nonce). The push-side boundary
 * nodes (HttpOut) lazily default their client to this so a fresh palette-drop
 * never needs the nonce threaded through construction args.
 */

import { CommandClient } from '../command-client';
import * as auth from '../command-auth';
import { Core } from '../core';
import { TYPE, TM_BYTESTREAM } from '../message';
import apiFetch from '@wordpress/api-fetch';

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

/**
 * unpack() hands back a blank message for any line that is not a 7-field array,
 * and postBatch used to fill every line straight into the graph — so one bad
 * response line became a ghost message with no TYPE, no FROM and no TO, and
 * surfaced as `_router: WARNING: message not addressed`. Reject it at the wire.
 */
describe( 'CommandClient.postBatch — unparseable response lines', () => {
	const okLine = JSON.stringify( [
		TM_BYTESTREAM,
		1,
		'a',
		'b',
		'',
		'',
		'v',
	] );

	afterEach( () => {
		delete global.fetch;
		Core.reset();
	} );

	const clientFor = ( body ) => {
		global.fetch = jest.fn().mockResolvedValue( {
			text: () => Promise.resolve( body ),
		} );
		return new CommandClient( { baseUrl: '/wp-json/', nonce: 'N' } );
	};

	it( 'drops a line that is not a 7-field message, and warns', async () => {
		const warn = jest
			.spyOn( Core, 'printLessOften' )
			.mockImplementation( () => {} );
		const client = clientFor( `${ okLine }\nnot json at all\n[]` );

		const messages = await client.postBatch( [], [] );

		expect( messages ).toHaveLength( 1 );
		expect( messages[ 0 ][ TYPE ] ).toBe( TM_BYTESTREAM );
		expect( warn ).toHaveBeenCalledWith(
			'ERROR: CommandClient: dropped an unparseable /command response line'
		);
		warn.mockRestore();
	} );

	it( 'passes a well-formed batch through untouched', async () => {
		const client = clientFor( `${ okLine }\n${ okLine }` );
		expect( await client.postBatch( [], [] ) ).toHaveLength( 2 );
	} );
} );

/**
 * A non-2xx /command returns a WP REST error OBJECT, not JSONL — so unpack()
 * blanked it and the failure surfaced as a ghost at _router instead of as the
 * HTTP error it was. An expired nonce (401 rest_forbidden) or a deactivated
 * plugin (404 rest_no_route) must SAY so.
 */
describe( 'CommandClient — HTTP failures', () => {
	afterEach( () => {
		delete global.fetch;
		Core.reset();
	} );

	const failing = ( status, code ) => {
		global.fetch = jest.fn().mockResolvedValue( {
			ok: false,
			status,
			text: () =>
				Promise.resolve(
					JSON.stringify( {
						code,
						message: 'nope',
						data: { status },
					} )
				),
		} );
		return new CommandClient( { baseUrl: '/wp-json/', nonce: 'N' } );
	};

	it( 'reports a 404 rest_no_route instead of routing a ghost', async () => {
		const warn = jest
			.spyOn( Core, 'printLessOften' )
			.mockImplementation( () => {} );

		const messages = await failing( 404, 'rest_no_route' ).postBatch(
			[],
			[]
		);

		expect( messages ).toEqual( [] );
		expect( warn ).toHaveBeenCalledWith(
			'ERROR: CommandClient: /command failed - HTTP 404 rest_no_route'
		);
		warn.mockRestore();
	} );

	// The substrate answers 401 when it refused a command's session. The reply
	// body says so too, but a non-2xx returns before the JSONL is ever parsed —
	// so the STATUS has to trigger the renewal, or a tab re-signs with a dead
	// handle every couple of seconds forever.
	it( 'renews the session when the substrate answers 401', async () => {
		const warn = jest
			.spyOn( Core, 'printLessOften' )
			.mockImplementation( () => {} );
		const renew = jest.spyOn( auth, 'renewSession' );

		await failing( 401, 'rest_forbidden' ).postBatch( [], [] );

		expect( renew ).toHaveBeenCalled();
		renew.mockRestore();
		warn.mockRestore();
	} );

	it( 'reports an expired nonce (401 rest_forbidden)', async () => {
		const warn = jest
			.spyOn( Core, 'printLessOften' )
			.mockImplementation( () => {} );

		await failing( 401, 'rest_forbidden' ).postBatch( [], [] );

		expect( warn ).toHaveBeenCalledWith(
			'ERROR: CommandClient: /command failed - HTTP 401 rest_forbidden'
		);
		warn.mockRestore();
	} );

	it( 'renews an invalid REST nonce and retries the command once', async () => {
		const previousEndpoint = apiFetch.nonceEndpoint;
		const previousMiddleware = apiFetch.nonceMiddleware;
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'STALE-COMMAND-NONCE-271',
		};
		apiFetch.nonceEndpoint =
			'https://example.test/wp-admin/admin-ajax.php?action=rest-nonce';
		apiFetch.nonceMiddleware = { nonce: 'STALE-COMMAND-NONCE-271' };
		global.fetch = jest
			.fn()
			.mockResolvedValueOnce( {
				ok: false,
				status: 403,
				text: () =>
					Promise.resolve(
						JSON.stringify( {
							code: 'rest_cookie_invalid_nonce',
						} )
					),
			} )
			.mockResolvedValueOnce( {
				ok: true,
				text: () => Promise.resolve( 'FRESH-COMMAND-NONCE-649' ),
			} )
			.mockResolvedValueOnce( {
				ok: true,
				status: 202,
				text: () => Promise.resolve( '' ),
			} );
		const client = CommandClient.fromGlobal();

		try {
			expect( await client.postBatch( [], [] ) ).toEqual( [] );
			expect( global.fetch ).toHaveBeenCalledTimes( 3 );
			expect( global.fetch.mock.calls[ 0 ][ 1 ].headers ).toEqual(
				expect.objectContaining( {
					'X-WP-Nonce': 'STALE-COMMAND-NONCE-271',
				} )
			);
			expect( global.fetch.mock.calls[ 2 ][ 1 ].headers ).toEqual(
				expect.objectContaining( {
					'X-WP-Nonce': 'FRESH-COMMAND-NONCE-649',
				} )
			);
			expect( client.nonce ).toBe( 'FRESH-COMMAND-NONCE-649' );
		} finally {
			delete global.fetch;
			delete window.NewspackNodesData;
			apiFetch.nonceEndpoint = previousEndpoint;
			apiFetch.nonceMiddleware = previousMiddleware;
		}
	} );

	it( 'does not replace an explicit remote credential with the local nonce', async () => {
		const previousEndpoint = apiFetch.nonceEndpoint;
		const previousMiddleware = apiFetch.nonceMiddleware;
		window.NewspackNodesData = {
			restUrl: 'https://local.example/wp-json/',
			nonce: 'LOCAL-PAGE-NONCE-433',
		};
		apiFetch.nonceEndpoint =
			'https://local.example/wp-admin/admin-ajax.php?action=rest-nonce';
		apiFetch.nonceMiddleware = { nonce: 'LOCAL-PAGE-NONCE-433' };
		global.fetch = jest
			.fn()
			.mockResolvedValueOnce( {
				ok: false,
				status: 403,
				text: () =>
					Promise.resolve(
						JSON.stringify( {
							code: 'rest_cookie_invalid_nonce',
						} )
					),
			} )
			.mockResolvedValueOnce( {
				ok: true,
				text: () => Promise.resolve( 'LOCAL-FRESH-NONCE-881' ),
			} )
			.mockResolvedValueOnce( {
				ok: false,
				status: 403,
				text: () =>
					Promise.resolve(
						JSON.stringify( {
							code: 'rest_cookie_invalid_nonce',
						} )
					),
			} );
		const warn = jest
			.spyOn( Core, 'printLessOften' )
			.mockImplementation( () => {} );
		const client = new CommandClient( {
			baseUrl: 'https://remote.example/wp-json/',
			nonce: 'REMOTE-PRIVATE-NONCE-727',
		} );

		try {
			expect( await client.postBatch( [], [] ) ).toEqual( [] );
			expect( global.fetch ).toHaveBeenCalledTimes( 1 );
			expect( global.fetch.mock.calls[ 0 ][ 0 ] ).toBe(
				'https://remote.example/wp-json/newspack-nodes/v1/command'
			);
			expect( client.nonce ).toBe( 'REMOTE-PRIVATE-NONCE-727' );
		} finally {
			warn.mockRestore();
			delete global.fetch;
			delete window.NewspackNodesData;
			apiFetch.nonceEndpoint = previousEndpoint;
			apiFetch.nonceMiddleware = previousMiddleware;
		}
	} );
} );

/**
 * A refusal at the REST boundary and a worker that answered with nothing both
 * used to collapse to null, so the console blamed the worker for an expired
 * session — and sent an operator into haproxy logs for a browser-side
 * condition. send() must tell them apart.
 */
describe( 'CommandClient — refused batches', () => {
	afterEach( () => {
		delete global.fetch;
		delete window.NewspackNodesData;
	} );

	const respond = ( response ) => {
		global.fetch = jest.fn().mockResolvedValue( response );
		return new CommandClient( { baseUrl: '/wp-json/', nonce: 'N' } );
	};

	it( 'leaves postBatch resolving to [] so the drain loop never throws', async () => {
		expectConsoleWarn( 'ERROR: CommandClient: /command failed - HTTP 401' );
		const client = respond( {
			ok: false,
			status: 401,
			text: () => Promise.resolve( '{}' ),
		} );

		await expect( client.postBatch( [], [] ) ).resolves.toEqual( [] );
	} );
} );
