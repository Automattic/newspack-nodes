import { Node } from '../node';

class TestArgsNode extends Node {
	constructor() {
		super();
		this.name_field = '';
		this.count = 0;
		this.flag = false;
	}

	static nodeSchema() {
		return {
			arguments: [
				{ name: 'name_field', type: 'string', required: true },
				{ name: 'count', type: 'int', default: 0 },
				{ name: 'flag', type: 'bool', default: false },
			],
			commands: [],
		};
	}
}

describe( 'Node arguments accessor (trivial Tachikoma getter/setter)', () => {
	it( 'setter stores the token array WITHOUT parsing it onto properties', () => {
		const n = new TestArgsNode();
		n.arguments = [ 'hello', '7', 'true' ];
		// Trivial store — no schema walk; declared props stay at ctor values.
		expect( n.name_field ).toBe( '' );
		expect( n.count ).toBe( 0 );
		expect( n.flag ).toBe( false );
	} );

	it( 'getter returns the last-set token array', () => {
		const n = new TestArgsNode();
		n.arguments = [ 'hello', '7', 'true' ];
		expect( n.arguments ).toEqual( [ 'hello', '7', 'true' ] );
	} );
} );
