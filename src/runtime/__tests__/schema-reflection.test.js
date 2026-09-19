/**
 * SchemaReflection — the JS counterpart of PHP's `Schema_Reflection` trait.
 * A node mixing it in has its `arguments` tokens walked onto the properties
 * its `nodeSchema()` declares, coerced to each declared type.
 */

import { Node } from '../node';
import { SchemaReflection, truthy } from '../schema-reflection';

class TestArgsNode extends SchemaReflection( Node ) {
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

describe( 'SchemaReflection — the positional walk `arguments =` runs', () => {
	it( 'parses tokens and assigns to named properties', () => {
		const n = new TestArgsNode();
		n.arguments = [ 'hello', '7', 'true' ];
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 7 );
		expect( n.flag ).toBe( true );
	} );

	it( 'stores the tokens it walked, for the getter and dump_config', () => {
		const n = new TestArgsNode();
		n.arguments = [ 'juliet-5', '12' ];
		expect( n.arguments ).toEqual( [ 'juliet-5', '12' ] );
		expect( n.count ).toBe( 12 );
	} );

	it( 'missing optional tokens use schema defaults', () => {
		const n = new TestArgsNode();
		n.arguments = [ 'hello' ];
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 0 );
		expect( n.flag ).toBe( false );
	} );

	it( 'empty arguments string leaves optional constructor values alone', () => {
		class CustomNode extends SchemaReflection( Node ) {
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
		n.arguments = [];
		expect( n.x ).toBe( 99 );
		expect( n.y ).toBe( 'ctor' );
	} );

	it( 'refuses a non-numeric int token instead of assigning NaN', () => {
		// parseInt( 'abc', 10 ) is NaN, and NaN silently poisons every later
		// comparison — the PHP mirror refuses, so this must too.
		const n = new TestArgsNode();
		expect( () => ( n.arguments = [ 'hello', 'abc' ] ) ).toThrow( 'count' );
	} );

	it( 'refuses a fractional int token', () => {
		const n = new TestArgsNode();
		expect( () => ( n.arguments = [ 'hello', '9.9' ] ) ).toThrow( 'count' );
	} );

	it( 'reads an empty numeric token as absent', () => {
		const n = new TestArgsNode();
		n.arguments = [ 'hello', '', 'true' ];
		expect( n.count ).toBe( 0 );
		expect( n.flag ).toBe( true );
	} );

	it( 'refuses a non-numeric float token', () => {
		class RatioNode extends SchemaReflection( Node ) {
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
		expect( () => ( new RatioNode().arguments = [ 'soon' ] ) ).toThrow(
			'ratio'
		);
	} );

	it( 'missing required arguments fail at the schema boundary', () => {
		const n = new TestArgsNode();
		expect( () => ( n.arguments = [] ) ).toThrow(
			'Missing required argument: name_field'
		);
	} );

	it( 'rejects a schema argument without a matching node property', () => {
		class TypoNode extends SchemaReflection( Node ) {
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

		expect( () => ( new TypoNode().arguments = [ 'configured' ] ) ).toThrow(
			'Invalid argument specification: misspelled_field_947'
		);
	} );

	it( 'rejects inherited node methods as configuration properties', () => {
		class InheritedMethodNode extends SchemaReflection( Node ) {
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

		expect( () => ( node.arguments = [ 'violet-cleanup-619' ] ) ).toThrow(
			'Invalid argument specification: removeNode'
		);
		expect( typeof node.removeNode ).toBe( 'function' );
	} );

	it( 'rejects a schema argument without a name', () => {
		class NamelessNode extends SchemaReflection( Node ) {
			static nodeSchema() {
				return {
					arguments: [ { type: 'string', default: 'violet-863' } ],
					commands: [],
				};
			}
		}

		expect( () => ( new NamelessNode().arguments = [] ) ).toThrow(
			'Invalid argument specification: missing name at position 0'
		);
	} );

	it( 'bool coercion accepts truthy/falsy strings', () => {
		const n = new TestArgsNode();
		n.arguments = [ 'x', '0', 'yes' ];
		expect( n.flag ).toBe( true );
		n.arguments = [ 'x', '0', '1' ];
		expect( n.flag ).toBe( true );
		n.arguments = [ 'x', '0', 'false' ];
		expect( n.flag ).toBe( false );
	} );

	it( 'excess tokens are ignored', () => {
		const n = new TestArgsNode();
		n.arguments = [ 'hello', '7', 'true', 'extra', 'extra2' ];
		expect( n.name_field ).toBe( 'hello' );
		expect( n.count ).toBe( 7 );
		expect( n.flag ).toBe( true );
	} );

	it( 'a node with no declared arguments is left untouched', () => {
		class BareNode extends SchemaReflection( Node ) {
			static nodeSchema() {
				return { arguments: [], commands: [] };
			}
		}
		const n = new BareNode();
		expect( () => ( n.arguments = [ 'whatever' ] ) ).not.toThrow();
	} );
} );

/**
 * `truthy` is the JS mirror of PHP `Schema_Reflection::truthy()`. The PHP
 * docblock named it as the counterpart while no such export existed, so the
 * four-token list was inlined here and re-spelled elsewhere — ELN's
 * `set_is_hub` accepted `true`/`1` and rejected `yes`/`on`, and Age_Sieve used
 * a raw PHP cast that made every non-empty token true.
 *
 * These cases must stay identical to tests/unit/AgeSieveTest.php's providers.
 */
describe( 'truthy — the one bool parse', () => {
	it.each( [ '1', 'true', 'yes', 'on', 'ON', 'True' ] )(
		'reads %s as true',
		( token ) => expect( truthy( token ) ).toBe( true )
	);

	it.each( [ '0', 'false', 'no', 'off', '', 'maybe' ] )(
		'reads %s as false',
		( token ) => expect( truthy( token ) ).toBe( false )
	);

	it( 'coerces a non-string without throwing', () => {
		expect( truthy( 1 ) ).toBe( true );
		expect( truthy( undefined ) ).toBe( false );
	} );
} );
