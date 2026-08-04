/**
 * tslArgs — the quoting + default-filling rule the live-drop modal shares with
 * what the editor writes. Split out of `serializeTsl` when the draft
 * interpreter's `dumpDocument` replaced its graph-rendering half.
 */

import { serializeCtorArgs } from '../tslArgs';

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

	it( 'drops trailing empties (no default) to an empty string', () => {
		expect(
			serializeCtorArgs( [ '', '' ], [ { name: 'x', type: 'string' } ] )
		).toBe( '' );
	} );
} );
