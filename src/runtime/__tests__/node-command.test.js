import { Node } from '../node';
import { TYPE, VALUE, TM_COMMAND } from '../message';

describe( 'Node.command', () => {
	it( 'returns a TM_COMMAND message carrying the command envelope', () => {
		const node = new Node();
		const msg = node.command( 'connect_node', 'a b' );
		// eslint-disable-next-line no-bitwise
		expect( msg[ TYPE ] & TM_COMMAND ).toBe( TM_COMMAND );
		expect( msg[ VALUE ] ).toEqual( {
			name: 'connect_node',
			arguments: 'a b',
			payload: null,
		} );
	} );

	it( 'carries optional payload', () => {
		const node = new Node();
		const msg = node.command( 'set_target', 'foo', { extra: 1 } );
		expect( msg[ VALUE ].payload ).toEqual( { extra: 1 } );
	} );
} );
