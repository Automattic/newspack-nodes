/**
 * splitPair — the console's reader of a broker's `<source>:<target>` pair,
 * held to PHP `Remote_Source_Node::split_pair()` by one case list.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { graphFromTsl, splitPair } from '../draftToGraph';

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
			'make_node Remote_Source spoke-x9 lone <config:offsets_dir>/x9 <config:deadletter_dir>/x9 firehose.p<partition>:remote-job-rewrite sources/php:php-errors:partition\n'
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spoke-x9', to: 'remote-job-rewrite', roles: [ 'pair' ] },
			{ from: 'spoke-x9', to: 'php-errors:partition', roles: [ 'pair' ] },
		] );
	} );

	it( 'draws a group of brokers from the group, which stands for every member', () => {
		const graph = graphFromTsl(
			'make_node Vault_Group spokes Remote_Source spoke <config:offsets_dir>/<topology>.{id} <config:deadletter_dir>/<topology>.{id} firehose.p<partition>:remote-job-rewrite\n'
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spokes', to: 'remote-job-rewrite', roles: [ 'pair' ] },
		] );
	} );

	it( 'skips a pair with an empty half, as the broker refuses it', () => {
		const graph = graphFromTsl(
			'make_node Remote_Source spoke-q7 lone o d jobstats.p7 :marmot-sink tapir.p2:tapir-sink\n'
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spoke-q7', to: 'tapir-sink', roles: [ 'pair' ] },
		] );
	} );

	it( 'draws no pair edge for any other class', () => {
		const graph = graphFromTsl(
			'make_node Echo okapi-echo firehose.p0:sink\n'
		);

		expect( pairEdges( graph ) ).toEqual( [] );
	} );
} );
