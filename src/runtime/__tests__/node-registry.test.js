/**
 * NodeRegistry — the name→node table, split out of Core.
 *
 * Core was two things wearing one name: this table, and process state (clock,
 * rate-limited stderr, generation counters, teardown). The same seam Perl has,
 * where `%Tachikoma::Nodes` is the table and `$Tachikoma::Now` is not — and
 * Tachikoma's answer to a second namespace is a Job, i.e. a second process with
 * its own table. What isolates is the table, not the clock.
 *
 * A second registry is what lets an edit buffer hold a node called `firehose`
 * while a live graph holds a different one, without either knowing.
 */

import { NodeRegistry } from '../node-registry';
import { Core } from '../core';
import { TeeNode } from '../tee-node';

beforeEach( () => Core.reset() );

describe( 'NodeRegistry', () => {
	it( 'refuses a name it already holds', () => {
		const registry = new NodeRegistry();
		registry.registerNode( 'firehose', {} );

		expect( () => registry.registerNode( 'firehose', {} ) ).toThrow(
			/collision/
		);
	} );

	it( 'answers null for a name it does not hold, never undefined', () => {
		expect( new NodeRegistry().node( 'firehose' ) ).toBeNull();
	} );

	it( 'holds the same name as another registry, independently', () => {
		// The whole reason this exists. Two documents, one page.
		const draft = new NodeRegistry();
		const live = new NodeRegistry();
		const a = {};
		const b = {};

		draft.registerNode( 'firehose', a );
		live.registerNode( 'firehose', b );

		expect( draft.node( 'firehose' ) ).toBe( a );
		expect( live.node( 'firehose' ) ).toBe( b );
	} );
} );

describe( 'Core delegates to a registry', () => {
	it( 'still exposes `nodes` as a Map, which callers iterate', () => {
		const node = new TeeNode();
		node.name = 'quokka-tee';

		expect( Core.nodes instanceof Map ).toBe( true );
		expect( [ ...Core.nodes.keys() ] ).toContain( 'quokka-tee' );
		expect( Core.node( 'quokka-tee' ) ).toBe( node );
	} );

	it( 'empties the table on reset', () => {
		const node = new TeeNode();
		node.name = 'quokka-tee';

		Core.reset();

		expect( Core.node( 'quokka-tee' ) ).toBeNull();
		expect( Core.nodes.size ).toBe( 0 );
	} );
} );

describe( 'a Node registers where it belongs', () => {
	it( 'defaults to Core, so nothing existing changes', () => {
		const node = new TeeNode();
		node.name = 'quokka-tee';

		expect( Core.node( 'quokka-tee' ) ).toBe( node );
	} );

	it( 'registers in its own registry when given one, invisible to Core', () => {
		const draft = new NodeRegistry();
		const live = new TeeNode();
		live.name = 'firehose';

		const drafted = new TeeNode();
		drafted.registry = draft;
		drafted.name = 'firehose';

		expect( draft.node( 'firehose' ) ).toBe( drafted );
		expect( Core.node( 'firehose' ) ).toBe( live );
	} );

	it( 'unregisters from its own registry on rename', () => {
		const draft = new NodeRegistry();
		const node = new TeeNode();
		node.registry = draft;
		node.name = 'flames';

		node.name = 'flame-builder';

		expect( draft.node( 'flames' ) ).toBeNull();
		expect( draft.node( 'flame-builder' ) ).toBe( node );
		expect( Core.nodes.size ).toBe( 0 );
	} );
} );
