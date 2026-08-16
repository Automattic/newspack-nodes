/**
 * the command transport.fromGlobal — builds a the command transport from the PHP-localized
 * `window.NewspackNodesData` (REST base + command nonce). The push-side boundary
 * nodes (HttpOut) lazily default their client to this so a fresh palette-drop
 * never needs the nonce threaded through construction args.
 */

import { commandTransport, defaultTransport } from '../command-transport';
import * as auth from '../command-auth';
import { Core } from '../core';
import {
	newMessage,
	pack,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_BYTESTREAM,
	TM_COMMAND,
	TM_ERROR,
} from '../message';
import { IoTelemetry } from '../io-telemetry';
import names from '../reserved-node-names.json';
import apiFetch from '@wordpress/api-fetch';

describe( 'the command transport.fromGlobal', () => {
	afterEach( () => {
		delete window.NewspackNodesData;
	} );

	// The base + nonce are closed over, so the POST is where they show.
	const posted = () => global.fetch.mock.calls[ 0 ];

	it( 'posts to the localized restUrl with the localized nonce', async () => {
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'GNONCE',
		};
		global.fetch = jest
			.fn()
			.mockResolvedValue( { ok: true, text: async () => '' } );

		await defaultTransport().postBatch( [], [] );

		expect( posted()[ 0 ] ).toBe(
			'https://example.test/wp-json/newspack-nodes/v1/command'
		);
		expect( posted()[ 1 ].headers[ 'X-WP-Nonce' ] ).toBe( 'GNONCE' );
	} );

	it( 'falls back to the safe REST default when the global is absent', async () => {
		delete window.NewspackNodesData;
		global.fetch = jest
			.fn()
			.mockResolvedValue( { ok: true, text: async () => '' } );

		await defaultTransport().postBatch( [], [] );

		expect( posted()[ 0 ] ).toBe( '/wp-json/newspack-nodes/v1/command' );
		expect( posted()[ 1 ].headers[ 'X-WP-Nonce' ] ).toBe( '' );
	} );
} );

/**
 * unpack() hands back a blank message for any line that is not a 7-field array,
 * and postBatch used to fill every line straight into the graph — so one bad
 * response line became a ghost message with no TYPE, no FROM and no TO, and
 * surfaced as `_router: WARNING: message not addressed`. Reject it at the wire.
 */
describe( 'the command transport.postBatch — unparseable response lines', () => {
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
		return commandTransport( { baseUrl: '/wp-json/', nonce: 'N' } );
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
			'ERROR: dropped an unparseable /command response line'
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
describe( 'the command transport — HTTP failures', () => {
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
		return commandTransport( { baseUrl: '/wp-json/', nonce: 'N' } );
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
			'ERROR: /command failed - HTTP 404 rest_no_route'
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
			'ERROR: /command failed - HTTP 401 rest_forbidden'
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
		const client = defaultTransport();

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
			// The retry's header IS the observable; the nonce is closed over.
		} finally {
			delete global.fetch;
			delete window.NewspackNodesData;
			apiFetch.nonceEndpoint = previousEndpoint;
			apiFetch.nonceMiddleware = previousMiddleware;
		}
	} );

	/**
	 * The renewal case above posts an EMPTY batch, so the fabricated replies
	 * are `[].map(...)` and this is invisible to it. With real commands: the
	 * pre-retry 403 is recorded, the retry then SUCCEEDS with a 202 — the
	 * normal "routed onward, reply rides the stream" answer, whose body is
	 * empty. An empty success reads exactly like an empty refusal, so every
	 * command in the batch was answered with a TM_ERROR for a failure that
	 * had already been recovered, while its real reply was still in flight.
	 */
	it( 'does not fabricate refusals when the nonce retry succeeds with a 202', async () => {
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
						JSON.stringify( { code: 'rest_cookie_invalid_nonce' } )
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
		const client = defaultTransport();
		const one = newMessage();
		one[ TYPE ] = TM_COMMAND;
		one[ FROM ] = 'overview';
		one[ TO ] = 'demo.p0';
		one[ VALUE ] = { name: 'dump_metadata', arguments: [] };

		try {
			expect( await client.postBatch( [ one ] ) ).toEqual( [] );
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
		const client = commandTransport( {
			baseUrl: 'https://remote.example/wp-json/',
			nonce: 'REMOTE-PRIVATE-NONCE-727',
		} );

		try {
			expect( await client.postBatch( [], [] ) ).toEqual( [] );
			expect( global.fetch ).toHaveBeenCalledTimes( 1 );
			expect( global.fetch.mock.calls[ 0 ][ 0 ] ).toBe(
				'https://remote.example/wp-json/newspack-nodes/v1/command'
			);
			expect(
				global.fetch.mock.calls[ 0 ][ 1 ].headers[ 'X-WP-Nonce' ]
			).toBe( 'REMOTE-PRIVATE-NONCE-727' );
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
describe( 'the command transport — refused batches', () => {
	afterEach( () => {
		delete global.fetch;
		delete window.NewspackNodesData;
	} );

	const respond = ( response ) => {
		global.fetch = jest.fn().mockResolvedValue( response );
		return commandTransport( { baseUrl: '/wp-json/', nonce: 'N' } );
	};

	it( 'leaves postBatch resolving to [] so the drain loop never throws', async () => {
		expectConsoleWarn( 'ERROR: /command failed - HTTP 401' );
		const client = respond( {
			ok: false,
			status: 401,
			text: () => Promise.resolve( '{}' ),
		} );

		await expect( client.postBatch( [], [] ) ).resolves.toEqual( [] );
	} );
} );

// @longform
// A refused POST used to answer nothing at all, which is indistinguishable
// from a 202 the server routed onward — so a node waiting on a reply waited
// out its whole deadline for a failure the transport already knew about.
describe( 'the command transport — a refusal answers the minter', () => {
	afterEach( () => {
		delete global.fetch;
		delete window.NewspackNodesData;
	} );

	const posted = ( from, args = [] ) => {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = from;
		m[ TO ] = 'topologies';
		m[ VALUE ] = { name: 'list', arguments: args };
		return m;
	};

	it( 'answers each refused command with a TM_ERROR addressed back to it', async () => {
		expectConsoleWarn( 'ERROR: /command failed - HTTP 401' );
		global.fetch = jest.fn().mockResolvedValue( {
			ok: false,
			status: 401,
			text: () =>
				Promise.resolve( JSON.stringify( { code: 'rest_forbidden' } ) ),
		} );
		const client = commandTransport( {
			baseUrl: '/wp-json/',
			nonce: 'N',
		} );

		const replies = await client.postBatch( [
			posted( 'topologies:list' ),
			posted( 'vault:remove', [ 'spoke-4471' ] ),
		] );

		expect( replies ).toHaveLength( 2 );
		expect( replies[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
		expect( replies[ 0 ][ TO ] ).toBe( 'topologies:list' );
		expect( replies[ 1 ][ TO ] ).toBe( 'vault:remove' );
		expect( String( replies[ 0 ][ VALUE ].payload ) ).toMatch( /401/ );
		// @longform And it says which ask it answers. A minter retires its
		// outstanding send by matching the arguments back; naming only the
		// verb left a refused write outstanding forever, its button disabled
		// and the refusal never shown.
		expect( replies[ 1 ][ VALUE ].arguments ).toEqual( [ 'spoke-4471' ] );
	} );

	it( 'records a TM_ERROR reply WITH its cause, so the list shows a diagnosis', async () => {
		const reply = newMessage();
		reply[ TYPE ] = TM_COMMAND | TM_ERROR;
		reply[ TO ] = 'topologies:list';
		reply[ VALUE ] = 'NOT_AVAILABLE: no slot 0 lease';
		global.fetch = jest.fn().mockResolvedValue( {
			ok: true,
			status: 200,
			text: () => Promise.resolve( pack( reply ) ),
		} );
		IoTelemetry.clear();
		const client = commandTransport( { baseUrl: '/wp-json/', nonce: 'N' } );

		await client.postBatch( [ posted( 'topologies:list' ) ] );

		const snap = IoTelemetry.snapshot();
		expect( snap.errors ).toBe( 1 );
		// A textless tally leaves the operator a count and no diagnosis.
		expect( snap.messages.map( ( m ) => m.text ).join( '\n' ) ).toContain(
			'NOT_AVAILABLE: no slot 0 lease'
		);
	} );

	/**
	 * The heartbeat judges its own replies and logs the ones that matter, so
	 * its refusals reach the tile through `stderr` like every other logged
	 * line. Counting them here as well put the expected `slot_released` race —
	 * one per reconnect, forever — on the tile with no message beside it.
	 */
	it( 'leaves the heartbeat to judge its own refusals', async () => {
		const reply = newMessage();
		reply[ TYPE ] = TM_COMMAND | TM_ERROR;
		reply[ TO ] = names.HEARTBEAT;
		reply[ VALUE ] = 'SSE slot lease not owned: slot_released';
		global.fetch = jest.fn().mockResolvedValue( {
			ok: true,
			status: 200,
			text: () => Promise.resolve( pack( reply ) ),
		} );
		IoTelemetry.clear();
		const client = commandTransport( { baseUrl: '/wp-json/', nonce: 'N' } );

		await client.postBatch( [ posted( names.HEARTBEAT ) ] );

		expect( IoTelemetry.snapshot().errors ).toBe( 0 );
	} );

	/**
	 * `Http_In_Node::fill()` sets the status from the refusal latch on the
	 * FIRST reply written, so a batch holding ONE refused command answers 401
	 * with a JSONL body carrying the server's real replies — the refused one's
	 * diagnosis AND the successful ones. Fabricating refusals over that throws
	 * away both.
	 */
	it( 'routes the JSONL replies a 401 body carries, not a fabricated refusal', async () => {
		// The transport-level line is throttled per category; clear the window.
		Core.reset();
		expectConsoleWarn( 'ERROR: /command failed - HTTP 401' );
		const refused = newMessage();
		refused[ TYPE ] = TM_COMMAND | TM_ERROR;
		refused[ TO ] = 'topologies:list';
		refused[ VALUE ] = {
			name: 'list',
			payload: 'command signature invalid',
		};
		const served = newMessage();
		served[ TYPE ] = TM_COMMAND;
		served[ TO ] = 'topologies:get';
		served[ VALUE ] = { name: 'get', payload: 'combined.tsl' };
		global.fetch = jest.fn().mockResolvedValue( {
			ok: false,
			status: 401,
			text: () =>
				Promise.resolve(
					[ pack( refused ), pack( served ) ].join( '\n' )
				),
		} );
		IoTelemetry.clear();
		const client = commandTransport( { baseUrl: '/wp-json/', nonce: 'N' } );

		const replies = await client.postBatch( [
			posted( 'topologies:list' ),
			posted( 'topologies:get' ),
		] );

		expect( replies ).toHaveLength( 2 );
		expect( String( replies[ 0 ][ VALUE ].payload ) ).toBe(
			'command signature invalid'
		);
		expect( String( replies[ 1 ][ VALUE ].payload ) ).toBe(
			'combined.tsl'
		);
		// The body crossed the boundary, so its bytes are accounted for.
		expect( IoTelemetry.snapshot().bytesIn ).toBeGreaterThan( 0 );
	} );

	it( 'still fabricates a refusal when the body is a REST error object', async () => {
		expectConsoleWarn( 'ERROR: /command failed - HTTP 403' );
		global.fetch = jest.fn().mockResolvedValue( {
			ok: false,
			status: 403,
			text: () =>
				Promise.resolve( JSON.stringify( { code: 'rest_forbidden' } ) ),
		} );
		const client = commandTransport( { baseUrl: '/wp-json/', nonce: 'N' } );

		const replies = await client.postBatch( [
			posted( 'topologies:list' ),
		] );

		expect( replies ).toHaveLength( 1 );
		expect( String( replies[ 0 ][ VALUE ].payload ) ).toMatch(
			/Command refused \(HTTP 403 rest_forbidden\)/
		);
	} );

	it( 'says nothing for a 202 the server routed onward', async () => {
		global.fetch = jest.fn().mockResolvedValue( {
			ok: true,
			status: 202,
			text: () => Promise.resolve( '' ),
		} );
		const client = commandTransport( {
			baseUrl: '/wp-json/',
			nonce: 'N',
		} );

		await expect(
			client.postBatch( [ posted( 'topologies:list' ) ] )
		).resolves.toEqual( [] );
	} );
} );
