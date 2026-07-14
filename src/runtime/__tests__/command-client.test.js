/**
 * CommandClient.fromGlobal — builds a CommandClient from the PHP-localized
 * `window.NewspackNodesData` (REST base + command nonce). The push-side boundary
 * nodes (HttpOut) lazily default their client to this so a fresh palette-drop
 * never needs the nonce threaded through construction args.
 */

import { CommandClient } from '../command-client';
import { Core } from '../core';
import { TYPE, TM_BYTESTREAM } from '../message';

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
} );
