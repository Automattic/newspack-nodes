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

	it( 'empty arguments string leaves required fields at ctor defaults', () => {
		const n = new TestArgsNode();
		n.arguments = '';
		expect( n.name_field ).toBe( '' );
	} );

	it( 'empty arguments string applies schema defaults for optional fields', () => {
		class CustomNode extends Node {
			constructor() {
				super();
				// Ctor defaults intentionally DIFFER from schema defaults so
				// we can tell which one won.
				this.x = 99;
				this.y = 'ctor';
			}
			static nodeSchema() {
				return {
					arguments: [
						{ name: 'x', type: 'int', default: 5 },
						{ name: 'y', type: 'string', default: 'schema' },
					],
					commands: [],
				};
			}
		}
		const n = new CustomNode();
		n.arguments = '';
		expect( n.x ).toBe( 5 );
		expect( n.y ).toBe( 'schema' );
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
