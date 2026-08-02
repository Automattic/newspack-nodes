import { CommandClient } from '../command-client';
import {
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	pack,
	LOCAL,
} from '../message';

beforeEach( () => {
	global.fetch = jest.fn().mockResolvedValue( {
		// #post reads body as text + JSON.parses it (bare-202 → null).
		text: async () =>
			JSON.stringify( [
				TM_RESPONSE,
				1.23,
				'performance',
				'',
				'cmd-1',
				'',
				{ name: 'overview', payload: {} },
			] ),
	} );
} );

test( 'buildMessage returns a positional TM_COMMAND Message, 7 fields on the wire', () => {
	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	const msg = client.buildMessage( {
		to: 'demo.p0',
		verb: 'dump_metadata',
	} );
	expect( Array.isArray( msg ) ).toBe( true );
	// A local mint carries LOCAL at index 7; pack() slices it off, so the wire
	// shape is the canonical 7 and the in-memory one is 8.
	expect( msg[ LOCAL ] ).toBe( true );
	expect( JSON.parse( pack( msg ) ) ).toHaveLength( 7 );
	expect( msg[ TYPE ] ).toBe( TM_COMMAND );
	expect( msg[ TO ] ).toBe( 'demo.p0' );
	expect( msg[ FROM ] ).toBe( '' );
	// VALUE is the command object directly (no inner JSON).
	expect( msg[ VALUE ].name ).toBe( 'dump_metadata' );
} );

test( 'postBatch posts JSONL — one packed Message per line — to /command', async () => {
	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	const a = client.buildMessage( {
		to: 'topologies',
		verb: 'connect_worker_input',
		args: [ 'demo.p0' ],
	} );
	const b = client.buildMessage( { to: 'demo.p0', verb: 'dump_metadata' } );
	await client.postBatch( [ a, b ] );

	const lines = global.fetch.mock.calls[ 0 ][ 1 ].body.split( '\n' );
	expect( lines ).toHaveLength( 2 );
	expect( JSON.parse( lines[ 0 ] )[ TO ] ).toBe( 'topologies' );
	expect( JSON.parse( lines[ 1 ] )[ TO ] ).toBe( 'demo.p0' );
} );

/**
 * send() builds its own command, so it is a mint — and it is already async, so
 * unlike a poll tick it can simply WAIT for the session rather than skip. Boot
 * loads (`topologies list`, `classes list`) go through here; before this they
 * minted during the /auth round trip and were refused.
 */
