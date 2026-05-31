/**
 * Shell.dispatch — the single chokepoint every outgoing Message routes through
 * (sendCommand, parse-then-fill from the REPL, and GUI gestures). It invokes the
 * optional `onDispatch` tap, then fills `this.sink`. The tap lets the UI observe
 * graph-mutating commands (make_node / connect_node / …) uniformly, regardless of
 * which call site built the Message — that's how the Reset Graph chip stays in
 * sync for GUI and REPL alike. The Shell stays verb-agnostic: it only announces
 * "I dispatched a message".
 */

import { Shell } from '../shell';
import { VALUE } from '../../../runtime/message';

describe( 'Shell.dispatch', () => {
	it( 'fills the message into sink', () => {
		const captured = [];
		const shell = new Shell();
		shell.sink = { fill: ( m ) => captured.push( m ) };
		const msg = [];

		shell.dispatch( msg );

		expect( captured ).toEqual( [ msg ] );
	} );

	it( 'invokes the onDispatch tap with the message before filling sink', () => {
		const order = [];
		const shell = new Shell();
		shell.sink = { fill: () => order.push( 'sink' ) };
		shell.onDispatch = ( m ) => order.push( `tap:${ m[ VALUE ].name }` );

		shell.dispatch( [ , , , , , , { name: 'connect_node' } ] );

		expect( order ).toEqual( [ 'tap:connect_node', 'sink' ] );
	} );

	it( 'is a no-op without sink and tolerates no tap', () => {
		const shell = new Shell();
		expect( () => shell.dispatch( [] ) ).not.toThrow();
	} );

	it( 'routes sendCommand through dispatch so the tap sees the command', () => {
		const seen = [];
		const shell = new Shell();
		shell.sink = { fill: () => {} };
		shell.onDispatch = ( m ) => seen.push( m[ VALUE ].name );

		shell.sendCommand( '', 'make_node', 'Tee t' );

		expect( seen ).toEqual( [ 'make_node' ] );
	} );

	it( 'routes a parsed REPL line through dispatch so the tap sees the verb', () => {
		const seen = [];
		const shell = new Shell();
		shell.sink = { fill: () => {} };
		shell.onDispatch = ( m ) => seen.push( m[ VALUE ].name );

		shell.fill( 'connect_node a b' );

		expect( seen ).toEqual( [ 'connect_node' ] );
	} );
} );
