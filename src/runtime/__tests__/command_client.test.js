import { CommandClient } from '../command_client';
import { TYPE, TM_COMMAND } from '../message';

beforeEach( () => {
	global.fetch = jest.fn().mockResolvedValue( {
		json: async () => [
			16,
			1.23,
			'performance',
			'',
			'cmd-1',
			'',
			'{"name":"overview","payload":"{}"}',
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
	const body = JSON.parse( opts.body );
	expect( body.type ).toBe( TM_COMMAND );
	expect( body.to ).toBe( 'performance' );
	expect( body.from ).toBe( '_http' );
	const value = JSON.parse( body.value );
	expect( value.name ).toBe( 'overview' );
	// `arguments` is a literal-string CLI tail (default '' when caller passes
	// structured data via `payload` instead). `payload` carries the actual
	// args object — no JSON-string-in-string nesting.
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
	const body = JSON.parse( global.fetch.mock.calls[ 0 ][ 1 ].body );
	expect( body.from ).toBe( '_http/12345' );
	expect( body.key ).toBe( 'gui:typed' );
} );

test( 'send returns the parsed JSON response', async () => {
	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	const res = await client.send( { to: 'performance', verb: 'overview' } );
	expect( res[ TYPE ] ).toBe( 16 );
} );
