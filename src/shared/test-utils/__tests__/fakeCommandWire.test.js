/**
 * fakeCommandWire tests — the wire double every hook test seams at.
 *
 * The `batches` affordance is what lets a test assert what was posted without
 * replacing the transport: a suite has to be able to assert WHAT was posted,
 * or each one keeps a local copy of the same unpack loop.
 */

import {
	newMessage,
	pack,
	unpack,
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
	TM_NOREPLY,
} from '@newspack-nodes/runtime';
import { makeFakeCommandWire } from '../fakeCommandWire';

function commandLine( name, from = 'caller' ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = from;
	m[ TO ] = '_http/svc';
	m[ VALUE ] = {
		name,
		arguments: [],
		auth: { nonce: 'n0', sig: 'signed', handle: 'h0' },
	};
	return pack( m );
}

function unsignedCommandLine( name, from = 'caller' ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = from;
	m[ TO ] = '_http/svc';
	m[ VALUE ] = { name, arguments: [] };
	return pack( m );
}

test( 'records each POST as a batch of UNPACKED messages', async () => {
	const wire = makeFakeCommandWire( () => null );
	await wire( '/command', {
		body: [ commandLine( 'list_logs' ), commandLine( 'dump_log' ) ].join(
			'\n'
		),
	} );
	await wire( '/command', { body: commandLine( 'dump_metadata' ) } );

	expect( wire.batches ).toHaveLength( 2 );
	expect( wire.batches[ 0 ].map( ( m ) => m[ VALUE ].name ) ).toEqual( [
		'list_logs',
		'dump_log',
	] );
	expect( wire.batches[ 1 ].map( ( m ) => m[ VALUE ].name ) ).toEqual( [
		'dump_metadata',
	] );
} );

test( 'a batch carries the whole message, not just the verb name', async () => {
	const wire = makeFakeCommandWire( () => null );
	await wire( '/command', { body: commandLine( 'list_logs', 'rules:in' ) } );
	expect( wire.batches[ 0 ][ 0 ][ FROM ] ).toBe( 'rules:in' );
} );

// ADR-15: the MINTER signs. A new minter that forgets shipped once already,
// and the wire double is the one place that catches the next one for free.
test( 'refuses an unsigned request command the way the interpreter does', async () => {
	const wire = makeFakeCommandWire( () => 'ok' );
	const res = await wire( '/command', {
		body: unsignedCommandLine( 'topologies', 'seed:in' ),
	} );

	const reply = unpack( ( await res.text() ).split( '\n' )[ 0 ] );
	expect( reply[ TYPE ] & TM_ERROR ).toBeTruthy();
	expect( reply[ VALUE ].payload ).toBe( 'unauthorized: topologies\n' );
	expect( reply[ TO ] ).toBe( 'seed:in' );
} );

test( 'a suite testing the pre-auth path can opt the refusal out', async () => {
	const wire = makeFakeCommandWire( () => 'ok', { requireSignature: false } );
	const res = await wire( '/command', {
		body: unsignedCommandLine( 'topologies' ),
	} );

	const reply = unpack( ( await res.text() ).split( '\n' )[ 0 ] );
	expect( reply[ VALUE ].payload ).toBe( 'ok' );
} );

test( 'replies route back TO = FROM, so a caller needs no correlator', async () => {
	const wire = makeFakeCommandWire( ( m ) =>
		'list_logs' === m[ VALUE ].name ? [ 'a.p0' ] : undefined
	);
	const res = await wire( '/command', {
		body: [
			commandLine( 'list_logs', 'browse:list' ),
			commandLine( 'routed_onward' ),
		].join( '\n' ),
	} );
	const lines = ( await res.text() ).split( '\n' ).filter( Boolean );
	// The second command replies `undefined` — the server routed it onward.
	expect( lines ).toHaveLength( 1 );
} );

// PHP's check() refuses a command it cannot verify and interpret() answers
// it as unauthorized; only a VALUE that is no command struct goes unanswered.
const forgedCommand = ( value, type = TM_COMMAND ) => {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ TIMESTAMP ] = 'abc';
	m[ FROM ] = 'forged:in';
	m[ TO ] = '_http/svc';
	m[ VALUE ] = value;
	return pack( m );
};

test( 'refuses a command with a non-numeric TIMESTAMP as unauthorized', async () => {
	const replyFor = jest.fn( () => 'ok' );
	const wire = makeFakeCommandWire( replyFor );
	const res = await wire( '/command', {
		body: forgedCommand( { name: 'ls', arguments: [] } ),
	} );

	const reply = unpack( ( await res.text() ).split( '\n' )[ 0 ] );
	expect( replyFor ).not.toHaveBeenCalled();
	expect( reply[ TYPE ] ).toBe( TM_COMMAND | TM_ERROR );
	expect( reply[ VALUE ].payload ).toBe( 'unauthorized: ls\n' );
	expect( reply[ TO ] ).toBe( 'forged:in' );
} );

test.each( [
	[ 'a string VALUE', 'ls' ],
	[ 'a VALUE without a name', { arguments: [] } ],
] )(
	'answers nothing to %s, which is no command struct',
	async ( label, value ) => {
		const replyFor = jest.fn( () => 'ok' );
		const wire = makeFakeCommandWire( replyFor );
		const res = await wire( '/command', { body: forgedCommand( value ) } );

		expect( replyFor ).not.toHaveBeenCalled();
		expect( ( await res.text() ).trim() ).toBe( '' );
	}
);

test( 'answers nothing to an unauthorized TM_NOREPLY command', async () => {
	const wire = makeFakeCommandWire( () => 'ok' );
	const res = await wire( '/command', {
		body: forgedCommand(
			{ name: 'ls', arguments: [] },
			TM_COMMAND | TM_NOREPLY
		),
	} );

	expect( ( await res.text() ).trim() ).toBe( '' );
} );

// PHP's interpret() echoes `name` and `arguments` through Core::as_string():
// a scalar becomes its string, and anything else becomes ''.
test( 'echoes name and arguments as PHP strings', async () => {
	const wire = makeFakeCommandWire( () => 'ok' );
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ TO ] = '_http/svc';
	m[ VALUE ] = {
		name: 'scale',
		arguments: [ 3, true, false, null, [ 'x' ], 'four' ],
		auth: { nonce: 'n0', sig: 'signed', handle: 'h0' },
	};
	const res = await wire( '/command', { body: pack( m ) } );

	const reply = unpack( ( await res.text() ).split( '\n' )[ 0 ] );
	expect( reply[ VALUE ].arguments ).toEqual( [
		'3',
		'1',
		'',
		'',
		'',
		'four',
	] );
} );

test( 'drops a nameless struct whether or not it is signed', async () => {
	const replyFor = jest.fn( () => 'ok' );
	const wire = makeFakeCommandWire( replyFor, { requireSignature: false } );
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ TO ] = '_http/svc';
	m[ VALUE ] = { arguments: [] };
	const res = await wire( '/command', { body: pack( m ) } );

	expect( replyFor ).not.toHaveBeenCalled();
	expect( ( await res.text() ).trim() ).toBe( '' );
} );

// PHP's interpret() and JS _respond() send no reply to a TM_NOREPLY command.
test( 'answers nothing to an authorized TM_NOREPLY command', async () => {
	const replyFor = jest.fn( () => 'ran' );
	const wire = makeFakeCommandWire( replyFor );
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_NOREPLY;
	m[ FROM ] = 'caller';
	m[ TO ] = '_http/svc';
	m[ VALUE ] = {
		name: 'make_node',
		arguments: [ 'Tee', 'quiet-tee' ],
		auth: { nonce: 'n0', sig: 'signed', handle: 'h0' },
	};
	const res = await wire( '/command', { body: pack( m ) } );

	expect( replyFor ).toHaveBeenCalledTimes( 1 );
	expect( ( await res.text() ).trim() ).toBe( '' );
} );
