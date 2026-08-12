/**
 * ShellNode.dispatch — the single chokepoint every outgoing Message routes
 * through, an internal of fill(). It invokes the
 * optional `onDispatch` tap, then fills `this.sink`. The tap lets the UI observe
 * graph-mutating commands (make_node / connect_node / …) uniformly, regardless of
 * which call site built the Message — that's how the Reset Graph chip stays in
 * sync for GUI and REPL alike. The Shell stays verb-agnostic: it only announces
 * "I dispatched a message".
 */

import { ShellNode } from '../shell-node';
import { TYPE, VALUE, TM_NOREPLY, TM_BYTESTREAM, newMessage } from '../message';
import { ensureSession, forgetSession, __setAuthFetch } from '../command-auth';

// The one door (ADR-1): a typed line rides into the Shell in a TM_BYTESTREAM.
function typeLine( shell, line ) {
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ VALUE ] = line;
	shell.fill( m );
}

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

	it( 'routes a parsed REPL line through dispatch so the tap sees the verb', () => {
		const seen = [];
		const shell = new ShellNode();
		shell.sink = { fill: () => {} };
		shell.onDispatch = ( m ) => seen.push( m[ VALUE ].name );

		typeLine( shell, 'connect_node a b' );

		expect( seen ).toEqual( [ 'connect_node' ] );
	} );
} );

/**
 * The Shell completes its mint in stampNoreply(), not in dispatch(). TYPE is
 * signed material and stampNoreply is its last mutation, so that is the only
 * moment the message is finished. dispatch() just forwards.
 */
describe( 'ShellNode command signing', () => {
	const HANDLE = 'aaaa1111bbbb2222cccc3333dddd4444';

	beforeEach( async () => {
		forgetSession();
		__setAuthFetch( async () => ( {
			handle: HANDLE,
			key: 'shell-session-key-4242',
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
} );
