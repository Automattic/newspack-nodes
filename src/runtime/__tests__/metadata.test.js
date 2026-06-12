import { Core } from '../core';
import { Node } from '../node';
import { dumpMetadataPayload } from '../metadata-node';

describe( 'dumpMetadataPayload', () => {
	beforeEach( () => Core.reset() );

	it( 'maps a node to the dump_metadata field shape', () => {
		const a = new Node();
		a.setName( 'a' );
		a.target = 'b';
		a.counter = 7;
		const payload = dumpMetadataPayload();
		expect( payload.a ).toEqual(
			expect.objectContaining( {
				class: 'Node',
				counter: 7,
				target: 'b',
				sink: '',
				debug_state: 0,
				arguments: '',
			} )
		);
	} );

	it( 'skips patron-linked plumbing nodes', () => {
		const a = new Node();
		a.setName( 'a' );
		const b = new Node();
		b.setName( 'b' );
		b.patron = a;
		const payload = dumpMetadataPayload();
		expect( payload.a ).toBeDefined();
		expect( payload.b ).toBeUndefined();
	} );

	it( 'stamps the local reply pivot (_output) into the _header section', () => {
		const a = new Node();
		a.setName( 'a' );
		const payload = dumpMetadataPayload();
		// The in-browser interpreter's reply pivot is the bare Dumper `_output`,
		// so a local `connect_node <tee>` stores `_output` — matched against this.
		expect( payload._header ).toEqual( { pwd: '_output' } );
	} );
} );
