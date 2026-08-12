/**
 * draftToGraph — the read that replaced `parseTsl`.
 *
 * The distinction it has to keep, and the one the reducer never could: a
 * borrowed node is DESCRIBED by the include that supplies it, so it renders on
 * the canvas but is not the document's to declare.
 */

import { draftToGraph, graphFromTsl } from '../draftToGraph';
import { DraftInterpreterNode } from '../../../runtime/draft-interpreter-node';

describe( 'graphFromTsl', () => {
	it( 'reads a file without registering a second draft', () => {
		const a = graphFromTsl( 'make_node Grep aardvark ^x' );
		const b = graphFromTsl( 'make_node Grep pangolin ^y' );

		expect( a.nodes.map( ( n ) => n.id ) ).toContain( 'aardvark' );
		expect( b.nodes.map( ( n ) => n.id ) ).toContain( 'pangolin' );
	} );

	it( 'invents no node the document does not declare', () => {
		// `_repl` is the canvas's anchor, added where the draft becomes a
		// canvas graph. A document read that adds it would be a read that
		// reports a node no topology file contains.
		expect( graphFromTsl( '' ).nodes ).toEqual( [] );
	} );

	it( 'composes the include expansion, marking its nodes borrowed', () => {
		const graph = graphFromTsl( 'include shared-flames', {
			nodes: [
				{
					name: 'meerkat',
					class: 'Flame_Builder',
					origin: [ 'shared-flames' ],
				},
			],
			edges: [],
		} );
		const meerkat = graph.nodes.find( ( n ) => n.id === 'meerkat' );

		expect( meerkat.class ).toBe( 'Flame_Builder' );
		expect( meerkat.origin ).toEqual( [ 'shared-flames' ] );
	} );
} );

describe( 'draftToGraph', () => {
	it( 'reports a fan-out node’s extra targets as `also`', () => {
		const interpreter = new DraftInterpreterNode();
		interpreter.load(
			[
				'make_node Tee zebra',
				'make_node Grep ocelot ^a',
				'make_node Grep quokka ^b',
				'connect_node zebra ocelot',
				'connect_node zebra quokka',
			].join( '\n' )
		);
		const zebra = draftToGraph( interpreter ).nodes.find(
			( n ) => n.id === 'zebra'
		);

		// First target in `target`, the rest in `also` — dropping the first is
		// the shape bug this test exists to catch.
		expect( zebra.target ).toBe( 'ocelot' );
		expect( zebra.also ).toEqual( [ 'quokka' ] );
	} );
} );

describe( 'verb rows carry their provenance', () => {
	it( 'marks the include’s verbs seeded and the file’s not', () => {
		// The Inspector renders one list and lets any row be spliced. Keyed by
		// INDEX, removing a seeded row deletes a declared verb instead; the
		// flag is what makes the write-back identity-based.
		const graph = graphFromTsl(
			[
				'include shared',
				'command_node jobs:config set_a 1',
				'command_node jobs:config set_b 2',
			].join( '\n' ),
			{
				nodes: [
					{
						name: 'jobs',
						class: 'Job_Worker',
						origin: [ 'shared' ],
						verbs: [ { verb: 'set_seeded', args: [ '0' ] } ],
					},
				],
				edges: [],
			}
		);
		const rows = graph.nodes.find(
			( n ) => n.id === 'jobs'
		).verbInvocations;

		expect( rows.map( ( r ) => [ r.verb, r.seeded ] ) ).toEqual( [
			[ 'set_seeded', true ],
			[ 'set_a', undefined ],
			[ 'set_b', undefined ],
		] );
	} );
} );
