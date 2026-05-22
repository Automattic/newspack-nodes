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
	LOCAL,
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
	// VALUE carries the structured command object directly — no inner JSON layer.
	m[ VALUE ] = {
		name: 'echo',
		arguments: 'hi',
		payload: '',
	};
	m[ LOCAL ] = true; // in-process command — carries the provenance taint
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_RESPONSE ).toBeTruthy();
	expect( got[ 0 ][ TO ] ).toBe( 'caller' );
	expect( got[ 0 ][ ID ] ).toBe( 'cmd-1' );
	expect( got[ 0 ][ KEY ] ).toBe( 'gui:typed' );
	// Response VALUE is the { name, payload } object itself, not a JSON string.
	expect( got[ 0 ][ VALUE ] ).toEqual( {
		name: 'echo',
		payload: 'echoed: hi',
	} );
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
	m[ VALUE ] = {
		name: 'bad',
		arguments: '',
		payload: '',
	};
	m[ LOCAL ] = true;
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	expect( got[ 0 ][ VALUE ].payload ).toBe( 'boom' );
} );

test( 'command without LOCAL provenance is refused (unauthorized), verb not run', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	let ran = false;
	const ci = new CommandInterpreter();
	ci.setName( 'test_ci' );
	ci.sink = sink;
	ci.commands( {
		echo: () => {
			ran = true;
			return 'ok';
		},
	} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ VALUE ] = { name: 'echo', arguments: '', payload: '' };
	// No LOCAL — an injected/off-process command.
	ci.fill( m );

	expect( ran ).toBe( false );
	expect( got ).toHaveLength( 1 );
	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	expect( got[ 0 ][ VALUE ].payload ).toContain( 'unauthorized' );
} );

test( 'instance authorize override allows a command without LOCAL', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.setName( 'test_ci' );
	ci.sink = sink;
	ci.authorize = () => true;
	ci.commands( { echo: () => 'ok' } );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ VALUE ] = { name: 'echo', arguments: '', payload: '' };
	ci.fill( m );

	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_RESPONSE ).toBeTruthy();
	expect( got[ 0 ][ VALUE ].payload ).toBe( 'ok' );
} );

test( 'static defaultAuthorize can refuse even with LOCAL set', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	let ran = false;
	const ci = new CommandInterpreter();
	ci.setName( 'test_ci' );
	ci.sink = sink;
	ci.commands( {
		echo: () => {
			ran = true;
			return 'ok';
		},
	} );

	CommandInterpreter.defaultAuthorize = () => false;
	try {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ VALUE ] = { name: 'echo', arguments: '', payload: '' };
		m[ LOCAL ] = true;
		ci.fill( m );
		expect( ran ).toBe( false );
		// eslint-disable-next-line no-bitwise
		expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	} finally {
		CommandInterpreter.defaultAuthorize = null;
	}
} );

test( 'malformed command struct (non-object VALUE) drops the message silently', () => {
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
	// VALUE must be a { name, ... } object; a bare string is not a command struct.
	m[ VALUE ] = 'not a command struct';
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
