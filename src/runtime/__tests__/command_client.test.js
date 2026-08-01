import { forgetSession, hasSession, __setAuthFetch } from '../command-auth';
import { CommandClient } from '../command-client';
import {
	TYPE,
	FROM,
	TO,
	KEY,
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

test( 'send leaves FROM empty — the server HTTP_In stamps the _http boundary', async () => {
	const client = new CommandClient( {
		baseUrl: 'https://test/wp-json/',
		nonce: 'NONCE',
	} );
	await client.send( {
		to: 'performance',
		verb: 'overview',
		args: [ '--range=1h' ],
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
	// LOCAL never crosses: pack() slices index 7 off the wire.
	expect( msg ).toHaveLength( 7 );
	expect( msg[ TYPE ] ).toBe( TM_COMMAND );
	expect( msg[ TO ] ).toBe( 'performance' );
	expect( msg[ FROM ] ).toBe( '' );
	// VALUE is the structured command object directly (no separate stringify).
	const value = msg[ VALUE ];
	expect( value.name ).toBe( 'overview' );
	// `arguments` is the whole CLI tail the verb parses — no payload slot.
	expect( value.arguments ).toEqual( [ '--range=1h' ] );
	expect( value.payload ).toBeUndefined();
} );

test( 'send carries the KEY field through (FROM left empty for the server to stamp)', async () => {
	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	await client.send( {
		to: 'firehose-workers.p0/_command_interpreter',
		verb: 'dump_metadata',
		key: 'gui:typed',
	} );
	const msg = JSON.parse( global.fetch.mock.calls[ 0 ][ 1 ].body );
	expect( msg[ FROM ] ).toBe( '' );
	expect( msg[ KEY ] ).toBe( 'gui:typed' );
} );

test( 'send returns the parsed JSON response', async () => {
	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	const res = await client.send( { to: 'performance', verb: 'overview' } );
	expect( res[ TYPE ] ).toBe( TM_RESPONSE );
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
test( 'send waits for the session, so the command it mints is signed', async () => {
	forgetSession();
	__setAuthFetch( async () => ( {
		handle: 'cccc3333dddd4444eeee5555ffff6666',
		key: 'send-session-key-4242',
		expires_in: 3600,
		now: 1771000000,
	} ) );
	global.fetch = jest.fn().mockResolvedValue( {
		ok: true,
		status: 200,
		text: async () => '',
	} );

	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	await client.send( { to: 'topologies', verb: 'list' } );

	const body = global.fetch.mock.calls[ 0 ][ 1 ].body;
	const sent = JSON.parse( body );
	expect( sent[ VALUE ].auth.handle ).toBe(
		'cccc3333dddd4444eeee5555ffff6666'
	);
	forgetSession();
	__setAuthFetch( null );
} );

/**
 * A session the server no longer recognizes — evicted, or lost to a restart —
 * must be renewed, or the client retries the same dead handle forever. That is
 * also the throttle: renewing clears the session, so hasSession() goes false,
 * pollers skip their tick and send() waits until re-auth lands.
 *
 * The refusal arrives as a 401. Every command in a batch carries the SAME
 * handle, so a dead one refuses all of them and the first reply is always the
 * refusal — the status can say so, and the body never has to be read.
 */
test( 'a refusal renews the session instead of retrying the dead handle', async () => {
	forgetSession();
	let issued = 0;
	__setAuthFetch( async () => {
		issued++;
		return {
			handle: `${ issued }`.repeat( 32 ).slice( 0, 32 ),
			key: `key-${ issued }`,
			expires_in: 3600,
			now: 1771000000,
		};
	} );

	expectConsoleWarn( 'ERROR: CommandClient: /command failed - HTTP 401' );
	global.fetch = jest.fn().mockResolvedValue( {
		ok: false,
		status: 401,
		text: async () =>
			JSON.stringify( { code: 'rest_forbidden', data: { status: 401 } } ),
	} );

	const client = new CommandClient( { baseUrl: '/', nonce: 'N' } );
	// send() now reports a refusal rather than resolving null — a silent worker
	// and a refused session used to be indistinguishable to the caller.
	await expect(
		client.send( { to: 'topologies', verb: 'list' } )
	).rejects.toThrow( /refused/i );

	// The refused session is dropped, so nothing mints until re-auth.
	expect( hasSession() ).toBe( false );

	forgetSession();
	__setAuthFetch( null );
} );
