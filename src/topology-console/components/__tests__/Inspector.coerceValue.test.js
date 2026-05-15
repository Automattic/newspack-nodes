import { coerceValue } from '../Inspector';

describe( 'coerceValue', () => {
	it( 'empty string stays empty for all types', () => {
		expect( coerceValue( 'int', '', 0 ) ).toBe( '' );
		expect( coerceValue( 'float', '', 1.5 ) ).toBe( '' );
		expect( coerceValue( 'string', '', 'prev' ) ).toBe( '' );
	} );

	it( 'int: pure-numeric strings convert to numbers', () => {
		expect( coerceValue( 'int', '42', 0 ) ).toBe( 42 );
		expect( coerceValue( 'int', '-7', 0 ) ).toBe( -7 );
	} );

	it( 'int: TSL substitution tokens pass through as strings', () => {
		// `<partition>` is the canonical patron-supplied token; the TSL
		// loader resolves it at load time. Editor must preserve the raw
		// string instead of falling back to prevRaw on NaN.
		expect( coerceValue( 'int', '<partition>', 0 ) ).toBe( '<partition>' );
		expect( coerceValue( 'int', '<config:num_partitions>', 0 ) ).toBe(
			'<config:num_partitions>'
		);
	} );

	it( 'int: partial typing of a substitution token is preserved', () => {
		// While the operator is typing `<partition>` one character at a
		// time, every intermediate string must round-trip — otherwise
		// the first `<` keystroke gets swallowed and the field appears
		// stuck.
		expect( coerceValue( 'int', '<', 0 ) ).toBe( '<' );
		expect( coerceValue( 'int', '<p', 0 ) ).toBe( '<p' );
		expect( coerceValue( 'int', '<partition', 0 ) ).toBe( '<partition' );
	} );

	it( 'int: lossy numeric prefixes pass through as strings (not silently truncated)', () => {
		// `parseInt('123abc') === 123` would drop the `abc` portion —
		// surprising in an editor context. Require strict numeric match.
		expect( coerceValue( 'int', '123abc', 0 ) ).toBe( '123abc' );
	} );

	it( 'float: pure-numeric strings convert to numbers', () => {
		expect( coerceValue( 'float', '1.5', 0 ) ).toBe( 1.5 );
		expect( coerceValue( 'float', '-0.25', 0 ) ).toBe( -0.25 );
		expect( coerceValue( 'float', '1e3', 0 ) ).toBe( 1000 );
	} );

	it( 'float: TSL substitution tokens pass through as strings', () => {
		expect( coerceValue( 'float', '<config:max_lifespan>', 0 ) ).toBe(
			'<config:max_lifespan>'
		);
	} );

	it( 'bool: stores literal strings + substitution tokens', () => {
		expect( coerceValue( 'bool', 'true', '' ) ).toBe( 'true' );
		expect( coerceValue( 'bool', 'false', '' ) ).toBe( 'false' );
		expect( coerceValue( 'bool', '<config:enable_aggregator>', '' ) ).toBe(
			'<config:enable_aggregator>'
		);
	} );

	it( 'bool: normalizes legacy boolean values to strings', () => {
		expect( coerceValue( 'bool', true, '' ) ).toBe( 'true' );
		expect( coerceValue( 'bool', false, '' ) ).toBe( 'false' );
	} );

	it( 'string type: any input is preserved as-is', () => {
		expect( coerceValue( 'string', 'hello world', '' ) ).toBe(
			'hello world'
		);
		expect( coerceValue( 'string', '<partition>', '' ) ).toBe(
			'<partition>'
		);
	} );
} );
