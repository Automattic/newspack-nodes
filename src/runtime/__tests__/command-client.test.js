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
