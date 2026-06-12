import { Node, parseSchemaArgs } from '../node';

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
	it( 'setter stores the raw string WITHOUT parsing it onto properties', () => {
		const n = new TestArgsNode();
		n.arguments = 'hello 7 true';
		// Trivial store — no schema walk; declared props stay at ctor values.
		expect( n.name_field ).toBe( '' );
		expect( n.count ).toBe( 0 );
		expect( n.flag ).toBe( false );
	} );

	it( 'getter returns the last-set raw string', () => {
		const n = new TestArgsNode();
		n.arguments = 'hello 7 true';
		expect( n.arguments ).toBe( 'hello 7 true' );
	} );
} );

describe( 'parseSchemaArgs — the Schema_Reflection positional walk', () => {
	it( 'parses tokens and assigns to named properties', () => {
		const n = new TestArgsNode();
		parseSchemaArgs( n, 'hello 7 true' );
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 7 );
		expect( n.flag ).toBe( true );
	} );

	it( 'missing optional tokens use schema defaults', () => {
		const n = new TestArgsNode();
		parseSchemaArgs( n, 'hello' );
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 0 );
		expect( n.flag ).toBe( false );
	} );

	it( 'empty arguments string is a no-op (leaves ctor values)', () => {
		class CustomNode extends Node {
			constructor() {
				super();
				// Ctor defaults intentionally DIFFER from schema defaults.
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
		parseSchemaArgs( n, '' );
		// Mirrors PHP parse_schema_args: '' short-circuits before any assignment.
		expect( n.x ).toBe( 99 );
		expect( n.y ).toBe( 'ctor' );
	} );

	it( 'bool coercion accepts truthy/falsy strings', () => {
		const n = new TestArgsNode();
		parseSchemaArgs( n, 'x 0 yes' );
		expect( n.flag ).toBe( true );
		parseSchemaArgs( n, 'x 0 1' );
		expect( n.flag ).toBe( true );
		parseSchemaArgs( n, 'x 0 false' );
		expect( n.flag ).toBe( false );
	} );

	it( 'excess tokens are ignored', () => {
		const n = new TestArgsNode();
		parseSchemaArgs( n, 'hello 7 true extra extra2' );
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 7 );
		expect( n.flag ).toBe( true );
	} );

	it( 'a node with no declared arguments is left untouched', () => {
		class BareNode extends Node {
			static nodeSchema() {
				return { arguments: [], commands: [] };
			}
		}
		const n = new BareNode();
		expect( () => parseSchemaArgs( n, 'whatever' ) ).not.toThrow();
	} );
} );
