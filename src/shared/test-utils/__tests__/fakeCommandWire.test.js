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
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
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
		body: [ commandLine( 'list_logs' ), commandLine( 'log_status' ) ].join(
			'\n'
		),
	} );
	await wire( '/command', { body: commandLine( 'taillog' ) } );

	expect( wire.batches ).toHaveLength( 2 );
	expect( wire.batches[ 0 ].map( ( m ) => m[ VALUE ].name ) ).toEqual( [
		'list_logs',
		'log_status',
	] );
	expect( wire.batches[ 1 ].map( ( m ) => m[ VALUE ].name ) ).toEqual( [
		'taillog',
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
	expect( reply[ VALUE ].payload ).toBe( 'unauthorized: topologies' );
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
