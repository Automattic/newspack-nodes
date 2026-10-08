/**
 * splitPair — the console's reader of a broker's `<source>:<target>` pair,
 * held to PHP `Remote_Source_Node::split_pair()` by one case list.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { graphFromTsl, splitPair } from '../draftToGraph';
import brokerSchemas from '../../../../tests/fixtures/broker-schemas.json';

describe( 'splitPair parity with Remote_Source_Node::split_pair()', () => {
	const cases = JSON.parse(
		readFileSync(
			join( __dirname, '../../../../tests/fixtures/pair-split.json' ),
			'utf8'
		)
	);

	it.each( cases )( '%s', ( _label, token, source, target ) => {
		expect( splitPair( token ) ).toEqual( { source, target } );
	} );
} );

describe( 'a broker in the file being edited', () => {
	const pairEdges = ( graph ) =>
		graph.edges.filter( ( e ) => e.roles.includes( 'pair' ) );

	it( 'draws one pair edge per pair after its three named arguments', () => {
		const graph = graphFromTsl(
			'make_node Remote_Source spoke-x9 lone <config:offsets_dir>/x9 <config:deadletter_dir>/x9 firehose.p{partition}:remote-job-rewrite sources/php:php-errors:partition\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spoke-x9', to: 'remote-job-rewrite', roles: [ 'pair' ] },
			{ from: 'spoke-x9', to: 'php-errors:partition', roles: [ 'pair' ] },
		] );
	} );

	it( 'draws a group of brokers from the group, which stands for every member', () => {
		const graph = graphFromTsl(
			'make_node Vault_Group spokes Remote_Source spoke <config:offsets_dir>/<topology>.{id} <config:deadletter_dir>/<topology>.{id} firehose.p{partition}:remote-job-rewrite\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spokes', to: 'remote-job-rewrite', roles: [ 'pair' ] },
		] );
	} );

	it( 'skips a pair with an empty half, as the broker refuses it', () => {
		const graph = graphFromTsl(
			'make_node Remote_Source spoke-q7 lone o d jobstats.p7 :marmot-sink tapir.p2:tapir-sink\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spoke-q7', to: 'tapir-sink', roles: [ 'pair' ] },
		] );
	} );

	it( 'draws no pair edge for any other class', () => {
		const graph = graphFromTsl(
			'make_node Echo okapi-echo firehose.p0:sink\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [] );
	} );

	it( 'finds where the pairs start from the catalog, not a fixed offset', () => {
		const line =
			'make_node Remote_Source spoke-x9 lone o d tapir.p2:tapir-sink ibis.p1:ibis-sink\n';
		const shifted = brokerSchemas.map( ( entry ) =>
			'Remote_Source' === entry.shell_name
				? {
						...entry,
						arguments: [
							...entry.arguments.slice( 0, 3 ),
							{ name: 'heron_cap' },
							entry.arguments[ 3 ],
						],
				  }
				: entry
		);

		expect(
			pairEdges( graphFromTsl( line, null, brokerSchemas ) )
		).toEqual( [
			{ from: 'spoke-x9', to: 'tapir-sink', roles: [ 'pair' ] },
			{ from: 'spoke-x9', to: 'ibis-sink', roles: [ 'pair' ] },
		] );
		expect( pairEdges( graphFromTsl( line, null, shifted ) ) ).toEqual( [
			{ from: 'spoke-x9', to: 'ibis-sink', roles: [ 'pair' ] },
		] );
	} );

	it( 'reads a quoted pair as the value the broker reads', () => {
		const graph = graphFromTsl(
			'make_node Remote_Source spoke-x9 lone o d "tapir.p2:tapir-sink" \'ibis.p1:ibis-sink\'\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spoke-x9', to: 'tapir-sink', roles: [ 'pair' ] },
			{ from: 'spoke-x9', to: 'ibis-sink', roles: [ 'pair' ] },
		] );
	} );

	it( 'recognises a quoted child class in a group', () => {
		const graph = graphFromTsl(
			'make_node Vault_Group spokes "Remote_Source" spoke o/{id} d/{id} tapir.p2:tapir-sink\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spokes', to: 'tapir-sink', roles: [ 'pair' ] },
		] );
	} );

	describe( 'a broker an include supplies and the file claims', () => {
		const seeded = ( cls, args ) => ( {
			nodes: [
				{
					name: 'spokes',
					class: cls,
					args,
					fans_out: true,
					origin: [ 'hub-base' ],
					via: [ 'hub-base' ],
				},
			],
			edges: [ { from: 'spokes', to: 'sink-q', roles: [ 'pair' ] } ],
			tree: { 'hub-base': {} },
		} );

		it( "draws a claimed group's pair once", () => {
			const graph = graphFromTsl(
				'include hub-base\nmake_node Vault_Group spokes Remote_Source spoke o/{id} d/{id} egret.p0:sink-q\n',
				seeded( 'Vault_Group', [
					'Remote_Source',
					'spoke',
					'o/{id}',
					'd/{id}',
					'egret.p0:sink-q',
				] ),
				brokerSchemas
			);

			expect( pairEdges( graph ) ).toEqual( [
				{ from: 'spokes', to: 'sink-q', roles: [ 'pair' ] },
			] );
		} );

		it( "draws a claimed Remote_Source's pair once", () => {
			const graph = graphFromTsl(
				'include hub-base\nmake_node Remote_Source spokes tw0 o d egret.p0:sink-q\n',
				seeded( 'Remote_Source', [
					'tw0',
					'o',
					'd',
					'egret.p0:sink-q',
				] ),
				brokerSchemas
			);

			expect( pairEdges( graph ) ).toEqual( [
				{ from: 'spokes', to: 'sink-q', roles: [ 'pair' ] },
			] );
		} );
	} );

	it( 'refuses a graph read with no catalog', () => {
		expect( () => graphFromTsl( 'make_node Echo okapi-echo\n' ) ).toThrow(
			/catalog/
		);
	} );
} );
