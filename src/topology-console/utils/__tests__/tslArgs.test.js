/**
 * tslArgs — the quoting + default-filling rule the live-drop modal shares with
 * what the editor writes. Split out of `serializeTsl` when the draft
 * interpreter's `dumpDocument` replaced its graph-rendering half.
 */

import {
	absorbTrailingArgs,
	positionalTokens,
	serializeCtorArgs,
} from '../tslArgs';

describe( 'serializeCtorArgs', () => {
	const spec = [
		{ name: 'source_file', type: 'string', required: true },
		{ name: 'segment_size', type: 'int', default: 4096 },
	];

	it( 'joins positional values, single-quoting whitespace', () => {
		expect( serializeCtorArgs( [ 'a log', '8192' ], spec ) ).toBe(
			"'a log' 8192"
		);
	} );

	it( 'fills an empty slot from its schema default', () => {
		expect( serializeCtorArgs( [ 'in.log', '' ], spec ) ).toBe(
			'in.log 4096'
		);
	} );

	it( 'writes a trailing variadic one token per word', () => {
		const variadicSpec = [
			{ name: 'child_type', type: 'string', required: true },
			{ name: 'child_args', type: 'string', variadic: true },
		];
		expect(
			serializeCtorArgs(
				[ 'Remote_Source', 'egret.p0:heron crane:stork' ],
				variadicSpec
			)
		).toBe( 'Remote_Source egret.p0:heron crane:stork' );
	} );

	it( 'drops trailing empties (no default) to an empty string', () => {
		expect(
			serializeCtorArgs( [ '', '' ], [ { name: 'x', type: 'string' } ] )
		).toBe( '' );
	} );
} );

describe( 'serializeCtorArgs with a quoted variadic token', () => {
	it( 'keeps a quoted word as one token', () => {
		const spec = [
			{ name: 'child_type', type: 'string', required: true },
			{ name: 'child_args', type: 'string', variadic: true },
		];

		expect(
			serializeCtorArgs(
				[ 'Remote_Source', '"pond heron" ibis:tern' ],
				spec
			)
		).toBe( 'Remote_Source "pond heron" ibis:tern' );
	} );
} );

describe( 'absorbTrailingArgs', () => {
	it( 'joins the tail so the scanner reads the same tokens back', () => {
		expect(
			absorbTrailingArgs(
				[ 'Remote_Source', 'marsh', '"pond heron"', 'ibis', 'a b' ],
				3
			)
		).toEqual( [ 'Remote_Source', 'marsh', '"pond heron" ibis \'a b\'' ] );
	} );

	it( 'returns a list within the count unchanged', () => {
		const list = [ 'Remote_Source', '"pond heron"' ];

		expect( absorbTrailingArgs( list, 2 ) ).toBe( list );
	} );
} );

describe( 'positionalTokens with a misplaced variadic', () => {
	const misplaced = [
		{ name: 'tail', type: 'string', variadic: true },
		{ name: 'head', type: 'string' },
	];

	it( 'refuses it as the schema walk does', () => {
		expect( () =>
			positionalTokens( [ 'egret', 'heron' ], misplaced )
		).toThrow(
			'Invalid argument specification: variadic argument tail must be the last'
		);
	} );
} );
