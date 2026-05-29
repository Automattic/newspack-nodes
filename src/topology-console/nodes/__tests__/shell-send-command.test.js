/**
 * Shell.sendCommand — thin wrapper that builds a TM_COMMAND via Node.command()
 * (Task 1), stamps the session's FROM (via replyFrom( names.OUTPUT )) + LOCAL
 * provenance + the target TO, and fills it through this.sink. Mirrors
 * Tachikoma::Nodes::Shell::send_command — callers issue commands as method
 * calls instead of via parse().
 */

import { Shell } from '../shell';
import {
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from '../../../runtime/message';
import names from '../../../runtime/reserved-node-names.json';

describe( 'Shell.sendCommand', () => {
	it( 'builds a command message, stamps FROM/TO/LOCAL, and fills sink', () => {
		const captured = [];
		const sink = { fill: ( m ) => captured.push( m ) };
		const shell = new Shell();
		shell.sink = sink;

		shell.sendCommand( 'some/path', 'connect_node', 'a b' );

		expect( captured.length ).toBe( 1 );
		const m = captured[ 0 ];
		expect( m[ TYPE ] & TM_COMMAND ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( 'some/path' );
		expect( m[ FROM ] ).toBe( names.OUTPUT );
		expect( m[ LOCAL ] ).toBe( true );
		expect( m[ VALUE ] ).toEqual( {
			name: 'connect_node',
			arguments: 'a b',
			payload: null,
		} );
	} );

	it( 'is a no-op without sink', () => {
		const shell = new Shell();
		expect( () => shell.sendCommand( '', 'pwd', '' ) ).not.toThrow();
	} );
} );
