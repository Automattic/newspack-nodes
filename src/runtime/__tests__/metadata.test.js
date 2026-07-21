import { Core } from '../core';
import { Node } from '../node';
import { TeeNode } from '../tee-node';
import { RouterNode } from '../router-node';
import { dumpMetadataPayload } from '../metadata-node';

describe( 'dumpMetadataPayload', () => {
	beforeEach( () => {
		Core.reset();
		RouterNode.profiles( null );
	} );

	it( 'reports the SHELL name (strips the _Node suffix), matching the worker tier', () => {
		// Worker emits shell names (Tee); the in-browser tier must match them.
		const tee = new TeeNode();
		tee.name = 'firehose:tee';
		expect( dumpMetadataPayload()[ 'firehose:tee' ].class ).toBe( 'Tee' );
	} );

	it( 'maps a node to the dump_metadata field shape', () => {
		const a = new Node();
		a.name = 'a';
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
				arguments: [],
			} )
		);
	} );

	it( 'skips patron-linked plumbing nodes', () => {
		const a = new Node();
		a.name = 'a';
		const b = new Node();
		b.name = 'b';
		b.patron = a;
		const payload = dumpMetadataPayload();
		expect( payload.a ).toBeDefined();
		expect( payload.b ).toBeUndefined();
	} );

	it( 'stamps the local reply path (_output) + profiling state into the _header section', () => {
		const a = new Node();
		a.name = 'a';
		const payload = dumpMetadataPayload();
		// In-browser reply path is the bare Dumper _output; profiling off default.
		expect( payload._header ).toEqual( {
			pwd: '_output',
			profiling: false,
		} );
	} );

	it( 'reports profiling: true in the _header when the router is profiling', () => {
		const a = new Node();
		a.name = 'a';
		RouterNode.profiles( {} );
		expect( dumpMetadataPayload()._header.profiling ).toBe( true );
	} );
} );
