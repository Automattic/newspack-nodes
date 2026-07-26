/**
 * ShellNode.dispatch — the single chokepoint every outgoing Message routes through
 * (sendCommand, parse-then-fill from the REPL, and GUI gestures). It invokes the
 * optional `onDispatch` tap, then fills `this.sink`. The tap lets the UI observe
 * graph-mutating commands (make_node / connect_node / …) uniformly, regardless of
 * which call site built the Message — that's how the Reset Graph chip stays in
 * sync for GUI and REPL alike. The Shell stays verb-agnostic: it only announces
 * "I dispatched a message".
 */

import { ShellNode } from '../shell-node';
import { newMessage, TYPE, VALUE, TM_COMMAND } from '../message';
import { ensureSession, forgetSession, __setAuthFetch } from '../command-auth';

describe( 'ShellNode.dispatch', () => {
	it( 'fills the message into sink', () => {
		const captured = [];
		const shell = new ShellNode();
		shell.sink = { fill: ( m ) => captured.push( m ) };
		const msg = [];

		shell.dispatch( msg );

		expect( captured ).toEqual( [ msg ] );
	} );

	it( 'invokes the onDispatch tap with the message before filling sink', () => {
		const order = [];
		const shell = new ShellNode();
		shell.sink = { fill: () => order.push( 'sink' ) };
		shell.onDispatch = ( m ) => order.push( `tap:${ m[ VALUE ].name }` );

		shell.dispatch( [ , , , , , , { name: 'connect_node' } ] );

		expect( order ).toEqual( [ 'tap:connect_node', 'sink' ] );
	} );

	it( 'is a no-op without sink and tolerates no tap', () => {
		const shell = new ShellNode();
		expect( () => shell.dispatch( [] ) ).not.toThrow();
	} );

	it( 'routes sendCommand through dispatch so the tap sees the command', () => {
		const seen = [];
		const shell = new ShellNode();
		shell.sink = { fill: () => {} };
		shell.onDispatch = ( m ) => seen.push( m[ VALUE ].name );

		shell.sendCommand( '', 'make_node', [ 'Tee', 't' ] );

		expect( seen ).toEqual( [ 'make_node' ] );
	} );

	it( 'routes a parsed REPL line through dispatch so the tap sees the verb', () => {
		const seen = [];
		const shell = new ShellNode();
		shell.sink = { fill: () => {} };
		shell.onDispatch = ( m ) => seen.push( m[ VALUE ].name );

		shell.fill( 'connect_node a b' );

		expect( seen ).toEqual( [ 'connect_node' ] );
	} );
} );

/**
 * dispatch() is the mint-exit: sendCommand, the REPL's parse-then-fill, and the
 * GUI gestures all leave through it, so it is where the signature goes. Signing
 * at the mint is what stops HttpOut being an oracle — a wire-arrived frame
 * routed into `_http` never passes through here, so it ships unsigned and dies
 * at the server.
 *
 * It stays SYNCHRONOUS. The session is established at mount and the HMAC is
 * synchronous, so a caller mid-graph-mutation never yields.
 */
describe( 'ShellNode.dispatch signing', () => {
	const HANDLE = 'aaaa1111bbbb2222cccc3333dddd4444';

	beforeEach( async () => {
		forgetSession();
		__setAuthFetch( async () => ( {
			handle: HANDLE,
			key: 'shell-session-key-4242',
			expires_in: 3600,
		} ) );
		await ensureSession();
	} );

	afterEach( () => {
		forgetSession();
		__setAuthFetch( null );
	} );

	function aCommand( name ) {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ VALUE ] = { name, arguments: [] };
		return m;
	}

	it( 'signs a command before it reaches the sink, synchronously', () => {
		const captured = [];
		const shell = new ShellNode();
		shell.sink = { fill: ( m ) => captured.push( m ) };

		shell.dispatch( aCommand( 'help' ) );

		expect( captured ).toHaveLength( 1 );
		expect( captured[ 0 ][ VALUE ].auth.handle ).toBe( HANDLE );
		expect( captured[ 0 ][ VALUE ].auth.sig ).toMatch( /^[0-9a-f]{64}$/ );
	} );

	it( 'signs before the tap observes it, so the tap sees what ships', () => {
		const shell = new ShellNode();
		let seen = null;
		shell.sink = { fill: () => {} };
		shell.onDispatch = ( m ) => {
			seen = m[ VALUE ].auth;
		};

		shell.dispatch( aCommand( 'ls' ) );

		expect( seen.sig ).toMatch( /^[0-9a-f]{64}$/ );
	} );
} );
