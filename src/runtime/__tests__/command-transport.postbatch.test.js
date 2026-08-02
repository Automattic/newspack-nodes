import { commandTransport } from '../command-transport';
import {
	newMessage,
	TYPE,
	TO,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../message';

// The command shape HttpOut hands the transport (it mints; this is a stand-in).
const command = ( to, verb ) => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ TO ] = to;
	m[ VALUE ] = { name: verb, arguments: [] };
	return m;
};

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

test( 'postBatch posts JSONL — one packed Message per line — to /command', async () => {
	const client = commandTransport( { baseUrl: '/', nonce: 'N' } );
	const a = command( 'topologies', 'connect_worker_input' );
	const b = command( 'demo.p0', 'dump_metadata' );
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
