/**
 * ShellNode command signing: the Shell is a minter, so every message it parses
 * out of a typed line leaves it signed (ADR-15).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ShellNode } from '../shell-node';
import {
	TYPE,
	TIMESTAMP,
	VALUE,
	TM_NOREPLY,
	TM_BYTESTREAM,
	TM_COMMAND,
	newMessage,
} from '../message';
import {
	ensureSession,
	forgetSession,
	signCommand,
	__setAuthFetch,
} from '../command-auth';

// The one door (ADR-1): a typed line rides into the Shell in a TM_BYTESTREAM.
function typeLine( shell, line ) {
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ VALUE ] = line;
	shell.fill( m );
}

/**
 * The Shell completes its mint in stampNoreply(). TYPE is signed material and
 * stampNoreply is its last mutation, so that is the only moment the message is
 * finished; fill() just forwards it to the sink.
 */
describe( 'ShellNode command signing', () => {
	const HANDLE = 'aaaa1111bbbb2222cccc3333dddd4444';

	beforeEach( async () => {
		forgetSession();
		__setAuthFetch( async () => ( {
			handle: HANDLE,
			secret: 'shell-session-key-4242',
			expires_in: 3600,
			now: 1771000000,
		} ) );
		await ensureSession();
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
	} );

	it( 'signs a mint, with TM_NOREPLY already folded in', () => {
		const captured = [];
		const shell = new ShellNode();
		shell.sink = { fill: ( m ) => captured.push( m ) };

		shell._wantReply = false; // fire-and-forget: stampNoreply ORs the flag
		typeLine( shell, 'cmd workers status' );

		expect( captured ).toHaveLength( 1 );
		const sent = captured[ 0 ];
		expect( sent[ VALUE ].auth.handle ).toBe( HANDLE );
		expect( sent[ VALUE ].auth.sig ).toMatch( /^[0-9a-f]{64}$/ );
		// The signature must cover the FINAL type, NOREPLY included — signing
		// before stampNoreply would verify against the wrong TYPE.
		expect( sent[ TYPE ] & TM_NOREPLY ).toBe( TM_NOREPLY );
	} );

	it( 'signs a parsed REPL command', () => {
		const shell = new ShellNode();
		const parsed = shell.parse( 'ls' );

		expect( parsed[ VALUE ].auth.sig ).toMatch( /^[0-9a-f]{64}$/ );
	} );

	/**
	 * `var message.timestamp` forges the TIMESTAMP and the signer signs it as
	 * forged: the PHP-committed signature derives with the clock a day away.
	 */
	it( 'signs a command at its forged message.timestamp', async () => {
		const fixture = JSON.parse(
			readFileSync(
				join( __dirname, '../../../tests/fixtures/signatures.json' ),
				'utf8'
			)
		);
		const [ vector ] = fixture.vectors;
		forgetSession();
		__setAuthFetch( async () => ( {
			handle: HANDLE,
			secret: vector.key,
			expires_in: 3600,
		} ) );
		await ensureSession();
		const nonce = Uint8Array.from(
			vector.nonce.match( /../g ).map( ( b ) => parseInt( b, 16 ) )
		);
		jest.spyOn( Date, 'now' ).mockReturnValue(
			( vector.ts + 86400 ) * 1000
		);
		jest.spyOn( crypto, 'getRandomValues' ).mockImplementation( ( out ) => {
			out.set( nonce );
			return out;
		} );
		const captured = [];
		const shell = new ShellNode();
		shell.sink = { fill: ( m ) => captured.push( m ) };

		typeLine( shell, `var message.timestamp = ${ vector.ts }` );
		typeLine(
			shell,
			[ 'cmd', 'workers', vector.name, ...vector.arguments ]
				.map( ( t ) => `'${ t }'` )
				.join( ' ' )
		);
		jest.restoreAllMocks();

		expect( captured ).toHaveLength( 1 );
		expect( Number( captured[ 0 ][ TIMESTAMP ] ) ).toBe( vector.ts );
		expect( captured[ 0 ][ VALUE ].auth.sig ).toBe(
			fixture.signatures[ 0 ]
		);
	} );

	it( 'leaves a command with a non-numeric forged timestamp unsigned', () => {
		const captured = [];
		const shell = new ShellNode();
		shell.sink = { fill: ( m ) => captured.push( m ) };

		typeLine( shell, 'var message.timestamp = abc' );
		typeLine( shell, 'cmd workers status' );

		expect( captured[ 0 ][ TIMESTAMP ] ).toBe( 'abc' );
		expect( captured[ 0 ][ VALUE ] ).not.toHaveProperty( 'auth' );
	} );

	it( 'signs a command at a forged 1700000123, as the signer does', () => {
		const nonce = Uint8Array.from( { length: 16 }, ( _, i ) => 255 - i );
		jest.spyOn( crypto, 'getRandomValues' ).mockImplementation( ( out ) => {
			out.set( nonce );
			return out;
		} );
		const captured = [];
		const shell = new ShellNode();
		shell.sink = { fill: ( m ) => captured.push( m ) };
		typeLine( shell, 'var message.timestamp = 1700000123' );
		typeLine( shell, 'cmd workers make_node Tee forged-tee' );
		// The same command, signed at the same forged TIMESTAMP.
		const expected = newMessage();
		expected[ TYPE ] = TM_COMMAND;
		expected[ TIMESTAMP ] = '1700000123';
		expected[ VALUE ] = {
			name: 'make_node',
			arguments: [ 'Tee', 'forged-tee' ],
		};
		signCommand( expected, true );
		jest.restoreAllMocks();

		expect( captured[ 0 ][ TIMESTAMP ] ).toBe( '1700000123' );
		expect( captured[ 0 ][ VALUE ].auth ).toEqual( expected[ VALUE ].auth );
	} );
} );
