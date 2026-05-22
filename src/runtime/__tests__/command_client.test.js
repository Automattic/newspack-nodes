import { CommandClient } from '../command_client';
import {
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../message';

beforeEach( () => {
	global.fetch = jest.fn().mockResolvedValue( {
		// Response VALUE is a nested object (the whole-message envelope is the only JSON layer).
		json: async () => [
			TM_RESPONSE,
			1.23,
			'performance',
			'',
			'cmd-1',
			'',
			{ name: 'overview', payload: {} },
		],
	} );
} );

test( 'send defaults FROM=_http for local commands', async () => {
	const client = new CommandClient( {
		baseUrl: 'https://test/wp-json/',
		nonce: 'NONCE',
	} );
	await client.send( {
		to: 'performance',
		verb: 'overview',
		payload: { range: '1h' },
	} );
	expect( global.fetch ).toHaveBeenCalledTimes( 1 );
	const [ url, opts ] = global.fetch.mock.calls[ 0 ];
	expect( url ).toBe( 'https://test/wp-json/newspack-nodes/v1/command' );
	expect( opts.method ).toBe( 'POST' );
	expect( opts.headers[ 'X-WP-Nonce' ] ).toBe( 'NONCE' );
	// Non-JSON content type so WP doesn't 400 the JSONL body.
	expect( opts.headers[ 'Content-Type' ] ).toBe(
		'text/plain; charset=UTF-8'
	);
	const msg = JSON.parse( opts.body );
	// Body is a packed 7-element positional Message, not a keyed object.
	expect( Array.isArray( msg ) ).toBe( true );
	expect( msg ).toHaveLength( 7 );
	expect( msg[ TYPE ] ).toBe( TM_COMMAND );
	expect( msg[ TO ] ).toBe( 'performance' );
	expect( msg[ FROM ] ).toBe( '_http' );
	// VALUE is the structured command object directly (no separate stringify).
	const value = msg[ VALUE ];
	expect( value.name ).toBe( 'overview' );
	// `arguments` is the CLI tail; `payload` carries structured args.
	expect( value.arguments ).toBe( '' );
	expect( value.payload ).toEqual( { range: '1h' } );
} );

test( 'send with ssePid produces FROM=_http/<ssePid> for pivoted mode', async () => {
	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	await client.send( {
		to: 'firehose-workers.p0/_command_interpreter',
		verb: 'dump_metadata',
		ssePid: 12345,
		key: 'gui:typed',
	} );
	const msg = JSON.parse( global.fetch.mock.calls[ 0 ][ 1 ].body );
	expect( msg[ FROM ] ).toBe( '_http/12345' );
	expect( msg[ KEY ] ).toBe( 'gui:typed' );
} );

test( 'send returns the parsed JSON response', async () => {
	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	const res = await client.send( { to: 'performance', verb: 'overview' } );
	expect( res[ TYPE ] ).toBe( TM_RESPONSE );
} );

test( 'buildMessage returns a positional 7-element TM_COMMAND Message', () => {
	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	const msg = client.buildMessage( {
		to: 'demo.p0',
		verb: 'dump_metadata',
		ssePid: 7,
	} );
	expect( Array.isArray( msg ) ).toBe( true );
	expect( msg ).toHaveLength( 7 );
	expect( msg[ TYPE ] ).toBe( TM_COMMAND );
	expect( msg[ TO ] ).toBe( 'demo.p0' );
	expect( msg[ FROM ] ).toBe( '_http/7' );
	// VALUE is the command object directly (no inner JSON).
	expect( msg[ VALUE ].name ).toBe( 'dump_metadata' );
} );

test( 'postBatch posts JSONL — one packed Message per line — to /command', async () => {
	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	const a = client.buildMessage( {
		to: 'topologies',
		verb: 'connect_worker_input',
		args: 'demo.p0',
	} );
	const b = client.buildMessage( { to: 'demo.p0', verb: 'dump_metadata' } );
	await client.postBatch( [ a, b ] );

	const lines = global.fetch.mock.calls[ 0 ][ 1 ].body.split( '\n' );
	expect( lines ).toHaveLength( 2 );
	expect( JSON.parse( lines[ 0 ] )[ TO ] ).toBe( 'topologies' );
	expect( JSON.parse( lines[ 1 ] )[ TO ] ).toBe( 'demo.p0' );
} );
