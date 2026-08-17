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

describe( 'parseSchemaArgs — the Schema_Reflection positional walk', () => {
	it( 'parses tokens and assigns to named properties', () => {
		const n = new TestArgsNode();
		parseSchemaArgs( n, [ 'hello', '7', 'true' ] );
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 7 );
		expect( n.flag ).toBe( true );
	} );

	it( 'missing optional tokens use schema defaults', () => {
		const n = new TestArgsNode();
		parseSchemaArgs( n, [ 'hello' ] );
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 0 );
		expect( n.flag ).toBe( false );
	} );

	it( 'empty arguments string leaves optional constructor values alone', () => {
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
		parseSchemaArgs( n, [] );
		expect( n.x ).toBe( 99 );
		expect( n.y ).toBe( 'ctor' );
	} );

	it( 'refuses a non-numeric int token instead of assigning NaN', () => {
		// parseInt( 'abc', 10 ) is NaN, and NaN silently poisons every later
		// comparison — the PHP mirror refuses, so this must too.
		const n = new TestArgsNode();
		expect( () => parseSchemaArgs( n, [ 'hello', 'abc' ] ) ).toThrow(
			'count'
		);
	} );

	it( 'refuses a fractional int token', () => {
		const n = new TestArgsNode();
		expect( () => parseSchemaArgs( n, [ 'hello', '9.9' ] ) ).toThrow(
			'count'
		);
	} );

	it( 'reads an empty numeric token as absent', () => {
		const n = new TestArgsNode();
		parseSchemaArgs( n, [ 'hello', '', 'true' ] );
		expect( n.count ).toBe( 0 );
		expect( n.flag ).toBe( true );
	} );

	it( 'refuses a non-numeric float token', () => {
		class RatioNode extends Node {
			constructor() {
				super();
				this.ratio = 0;
			}
			static nodeSchema() {
				return {
					arguments: [ { name: 'ratio', type: 'float' } ],
					commands: [],
				};
			}
		}
		expect( () => parseSchemaArgs( new RatioNode(), [ 'soon' ] ) ).toThrow(
			'ratio'
		);
	} );

	it( 'missing required arguments fail at the schema boundary', () => {
		const n = new TestArgsNode();
		expect( () => parseSchemaArgs( n, [] ) ).toThrow(
			'Missing required argument: name_field'
		);
	} );

	it( 'rejects a schema argument without a matching node property', () => {
		class TypoNode extends Node {
			constructor() {
				super();
				this.actual_field = '';
			}
			static nodeSchema() {
				return {
					arguments: [
						{
							name: 'misspelled_field_947',
							type: 'string',
							required: true,
						},
					],
					commands: [],
				};
			}
		}

		expect( () =>
			parseSchemaArgs( new TypoNode(), [ 'configured' ] )
		).toThrow( 'Invalid argument specification: misspelled_field_947' );
	} );

	it( 'rejects inherited node methods as configuration properties', () => {
		class InheritedMethodNode extends Node {
			static nodeSchema() {
				return {
					arguments: [
						{
							name: 'removeNode',
							type: 'string',
							required: true,
						},
					],
					commands: [],
				};
			}
		}
		const node = new InheritedMethodNode();

		expect( () =>
			parseSchemaArgs( node, [ 'violet-cleanup-619' ] )
		).toThrow( 'Invalid argument specification: removeNode' );
		expect( typeof node.removeNode ).toBe( 'function' );
	} );

	it( 'rejects a schema argument without a name', () => {
		class NamelessNode extends Node {
			static nodeSchema() {
				return {
					arguments: [ { type: 'string', default: 'violet-863' } ],
					commands: [],
				};
			}
		}

		expect( () => parseSchemaArgs( new NamelessNode(), [] ) ).toThrow(
			'Invalid argument specification: missing name at position 0'
		);
	} );

	it( 'bool coercion accepts truthy/falsy strings', () => {
		const n = new TestArgsNode();
		parseSchemaArgs( n, [ 'x', '0', 'yes' ] );
		expect( n.flag ).toBe( true );
		parseSchemaArgs( n, [ 'x', '0', '1' ] );
		expect( n.flag ).toBe( true );
		parseSchemaArgs( n, [ 'x', '0', 'false' ] );
		expect( n.flag ).toBe( false );
	} );

	it( 'excess tokens are ignored', () => {
		const n = new TestArgsNode();
		parseSchemaArgs( n, [ 'hello', '7', 'true', 'extra', 'extra2' ] );
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
		expect( () => parseSchemaArgs( n, [ 'whatever' ] ) ).not.toThrow();
	} );
} );
