/**
 * ShellNode.sendCommand — thin wrapper that builds a TM_COMMAND via Node.command()
 * (Task 1), stamps the session's FROM (via replyFrom( names.OUTPUT )) + LOCAL
 * provenance + the target TO, and fills it through this.sink. Mirrors
 * Tachikoma::Nodes::Shell::send_command — callers issue commands as method
 * calls instead of via parse().
 */

import { ShellNode } from '../shell-node';
import { TYPE, FROM, TO, VALUE, LOCAL, TM_COMMAND } from '../message';
import names from '../reserved-node-names.json';
import { forgetSession } from '../command-auth';

describe( 'ShellNode.sendCommand', () => {
	it( 'builds a command message, stamps FROM/TO/LOCAL, and fills sink', () => {
		const captured = [];
		const sink = { fill: ( m ) => captured.push( m ) };
		const shell = new ShellNode();
		shell.sink = sink;

		shell.sendCommand( 'some/path', 'connect_node', [ 'a', 'b' ] );

		expect( captured.length ).toBe( 1 );
		const m = captured[ 0 ];
		expect( m[ TYPE ] & TM_COMMAND ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( 'some/path' );
		expect( m[ FROM ] ).toBe( names.OUTPUT );
		expect( m[ LOCAL ] ).toBe( true );
		expect( m[ VALUE ] ).toMatchObject( {
			name: 'connect_node',
			arguments: [ 'a', 'b' ],
		} );
	} );

	/** command() returns null unauthenticated; the caller must not deref it. */
	it( 'is a no-op with no session, rather than throwing', () => {
		forgetSession();
		const captured = [];
		const shell = new ShellNode();
		shell.sink = { fill: ( m ) => captured.push( m ) };

		expect( () =>
			shell.sendCommand( 'some/path', 'connect_node', [ 'a', 'b' ] )
		).not.toThrow();
		expect( captured ).toEqual( [] );
	} );

	it( 'is a no-op without sink', () => {
		const shell = new ShellNode();
		expect( () => shell.sendCommand( '', 'pwd', [] ) ).not.toThrow();
	} );
} );
