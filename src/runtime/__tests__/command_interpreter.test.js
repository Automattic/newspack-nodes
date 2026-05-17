import { CommandInterpreter } from '../command_interpreter';
import { Node } from '../node';
import { Core } from '../core';
import {
	TYPE,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_PING,
	TM_EOF,
	newMessage,
} from '../message';

beforeEach( () => Core.reset() );

test( 'non-TM_COMMAND message passes straight through to sink', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ VALUE ] = 'pass';
	ci.fill( m );
	expect( got ).toHaveLength( 1 );
} );

test( 'TM_COMMAND with non-empty TO is forwarded to sink (in transit)', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ TO ] = 'downstream';
	ci.fill( m );
	expect( got ).toHaveLength( 1 );
} );

test( 'TM_COMMAND with empty TO dispatches the named verb', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.setName( 'test_ci' );
	ci.sink = sink;
	ci.commands( {
		echo: ( self, args ) => `echoed: ${ args }`,
	} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ ID ] = 'cmd-1';
	m[ KEY ] = 'gui:typed';
	m[ VALUE ] = JSON.stringify( {
		name: 'echo',
		arguments: 'hi',
		payload: '',
	} );
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_RESPONSE ).toBeTruthy();
	expect( got[ 0 ][ TO ] ).toBe( 'caller' );
	expect( got[ 0 ][ ID ] ).toBe( 'cmd-1' );
	expect( got[ 0 ][ KEY ] ).toBe( 'gui:typed' );
	const payload = JSON.parse( got[ 0 ][ VALUE ] );
	expect( payload ).toEqual( { name: 'echo', payload: 'echoed: hi' } );
} );

test( 'verb throwing returns TM_COMMAND|TM_ERROR with the message', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.setName( 'test_ci' );
	ci.sink = sink;
	ci.commands( {
		bad: () => {
			throw new Error( 'boom' );
		},
	} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ ID ] = 'cmd-2';
	m[ VALUE ] = JSON.stringify( {
		name: 'bad',
		arguments: '',
		payload: '',
	} );
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	const payload = JSON.parse( got[ 0 ][ VALUE ] );
	expect( payload.payload ).toBe( 'boom' );
} );

test( 'invalid command JSON drops the message silently', () => {
	const warnSpy = jest
		.spyOn( console, 'warn' )
		.mockImplementation( () => {} );

	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ VALUE ] = 'not json';
	ci.fill( m );
	expect( got ).toHaveLength( 0 );

	warnSpy.mockRestore();
} );

test( 'TM_PING with empty TO bounces back to FROM via sink', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_PING;
	m[ FROM ] = 'caller';
	m[ VALUE ] = '1700000000.5'; // originating timestamp the caller will diff against
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TYPE ] ).toBe( TM_PING );
	expect( got[ 0 ][ TO ] ).toBe( 'caller' );
	// PHP CommandInterpreter::fill leaves FROM untouched on the bounce.
	expect( got[ 0 ][ FROM ] ).toBe( 'caller' );
	expect( got[ 0 ][ VALUE ] ).toBe( '1700000000.5' ); // payload preserved
} );

test( 'TM_EOF with empty TO bounces back to FROM via sink', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_EOF;
	m[ FROM ] = 'producer';
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TYPE ] ).toBe( TM_EOF );
	expect( got[ 0 ][ TO ] ).toBe( 'producer' );
} );

test( 'TM_PING with non-empty TO is forwarded as in-transit (no bounce)', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_PING;
	m[ FROM ] = 'caller';
	m[ TO ] = 'somewhere/else'; // not addressed at us
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TO ] ).toBe( 'somewhere/else' ); // TO unchanged
} );
