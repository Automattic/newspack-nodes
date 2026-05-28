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

describe( 'Node arguments accessor', () => {
	it( 'setter parses tokens and assigns to named properties', () => {
		const n = new TestArgsNode();
		n.arguments = 'hello 7 true';
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 7 );
		expect( n.flag ).toBe( true );
	} );

	it( 'getter returns the last-set raw string', () => {
		const n = new TestArgsNode();
		n.arguments = 'hello 7 true';
		expect( n.arguments ).toBe( 'hello 7 true' );
	} );

	it( 'missing optional tokens use schema defaults', () => {
		const n = new TestArgsNode();
		n.arguments = 'hello';
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 0 );
		expect( n.flag ).toBe( false );
	} );

	it( 'empty arguments string is a no-op for assignment', () => {
		const n = new TestArgsNode();
		n.arguments = '';
		expect( n.name_field ).toBe( '' );
	} );

	it( 'bool coercion accepts truthy/falsy strings', () => {
		const n = new TestArgsNode();
		n.arguments = 'x 0 yes';
		expect( n.flag ).toBe( true );
		n.arguments = 'x 0 1';
		expect( n.flag ).toBe( true );
		n.arguments = 'x 0 false';
		expect( n.flag ).toBe( false );
	} );

	it( 'excess tokens are ignored', () => {
		const n = new TestArgsNode();
		n.arguments = 'hello 7 true extra extra2';
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 7 );
		expect( n.flag ).toBe( true );
	} );
} );
