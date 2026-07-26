import { Node } from '../node';
import { TYPE, VALUE, LOCAL, TM_COMMAND } from '../message';
import { forgetSession } from '../command-auth';

describe( 'Node.command', () => {
	it( 'returns a TM_COMMAND message carrying the command envelope', () => {
		const node = new Node();
		const msg = node.command( 'connect_node', [ 'a', 'b' ] );
		expect( msg[ TYPE ] & TM_COMMAND ).toBe( TM_COMMAND );
		expect( msg[ VALUE ] ).toMatchObject( {
			name: 'connect_node',
			arguments: [ 'a', 'b' ],
		} );
	} );

	/**
	 * command() completes the message rather than only building it: it marks
	 * LOCAL and signs. Tachikoma's Node.pm::command() signs at build too. The
	 * mark is safe to set unconditionally because packed() slices to 7 fields,
	 * so LOCAL cannot cross a process boundary.
	 */
	it( 'marks LOCAL and signs the command it builds', () => {
		const node = new Node();

		const msg = node.command( 'connect_node', [ 'a', 'b' ] );

		expect( msg[ LOCAL ] ).toBe( true );
		expect( msg[ VALUE ].auth?.sig ).toMatch( /^[0-9a-f]{64}$/ );
	} );

	/** The gate that keeps an unauthenticated poll from emitting at all. */
	it( 'returns null when there is no session', () => {
		forgetSession();
		const node = new Node();

		expect( node.command( 'connect_node', [ 'a', 'b' ] ) ).toBeNull();
	} );

	/** Fail-loud arg validation runs before the gate, so it fires either way. */
	it( 'throws on non-array args even with no session', () => {
		forgetSession();
		const node = new Node();

		expect( () => node.command( 'connect_node', 'a b' ) ).toThrow(
			/token array/
		);
	} );
} );
