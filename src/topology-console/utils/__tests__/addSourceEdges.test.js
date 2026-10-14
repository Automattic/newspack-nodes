/**
 * A broker's add_source lines become pair edges in the console's TSL reader.
 */

import { graphFromTsl } from '../draftToGraph';
import brokerSchemas from '../../../../tests/fixtures/broker-schemas.json';

const pairEdges = ( graph ) =>
	graph.edges.filter( ( e ) => e.roles.includes( 'pair' ) );

describe( 'a broker’s add_source lines', () => {
	it( 'draw one pair edge per source the file declares', () => {
		const graph = graphFromTsl(
			'make_node Remote_Source spoke-x9 lone o d\n' +
				'command_node spoke-x9:config add_source firehose.p{partition} remote-job-rewrite\n' +
				'command_node spoke-x9:config add_source sources:php php-errors:partition\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spoke-x9', to: 'remote-job-rewrite', roles: [ 'pair' ] },
			{ from: 'spoke-x9', to: 'php-errors:partition', roles: [ 'pair' ] },
		] );
	} );

	it( 'read a quoted or named argument as the binder does', () => {
		const graph = graphFromTsl(
			'make_node Remote_Source spoke-x9 lone o d\n' +
				'command_node spoke-x9:config add_source "tapir.p2" \'tapir-sink\'\n' +
				'command_node spoke-x9:config add_source --local_node=ibis-sink --remote_log=ibis.p1\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ).map( ( e ) => e.to ) ).toEqual( [
			'tapir-sink',
			'ibis-sink',
		] );
	} );

	it( 'skip a line the verb refuses', () => {
		const graph = graphFromTsl(
			'make_node Remote_Source spoke-q7 lone o d\n' +
				'command_node spoke-q7:config add_source jobstats.p7\n' +
				'command_node spoke-q7:config add_source egret.p0 egret-sink stray-3\n' +
				'command_node spoke-q7:config add_source tapir.p2 tapir-sink\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spoke-q7', to: 'tapir-sink', roles: [ 'pair' ] },
		] );
	} );

	it( 'draw a repeated source once, as the verb takes it once', () => {
		const graph = graphFromTsl(
			'make_node Remote_Source spoke-r4 lone o d\n' +
				'command_node spoke-r4:config add_source wren.p6 wren-sink\n' +
				'command_node spoke-r4:config add_source wren.p6 wren-sink\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spoke-r4', to: 'wren-sink', roles: [ 'pair' ] },
		] );
	} );

	it( 'draw a group of brokers from the group', () => {
		const graph = graphFromTsl(
			'make_node Vault_Group spokes "Remote_Source" spoke o/{id} d/{id}\n' +
				'command_node spokes:config add_source firehose.p{partition} remote-job-rewrite\n',
			null,
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spokes', to: 'remote-job-rewrite', roles: [ 'pair' ] },
		] );
	} );

	it( 'draw nothing for a class whose catalog declares no add_source', () => {
		const catalog = [
			{
				shell_name: 'Okapi_Fan',
				arguments: [ { name: 'mode' } ],
				commands: [ { name: 'set_mode', args: [] } ],
			},
			...brokerSchemas,
		];
		const graph = graphFromTsl(
			'make_node Okapi_Fan fan-31 x\n' +
				'command_node fan-31:config add_source firehose.p0 sink-88\n' +
				'make_node Vault_Group fans Okapi_Fan fans x\n' +
				'command_node fans:config add_source firehose.p0 sink-88\n',
			null,
			catalog
		);

		expect( pairEdges( graph ) ).toEqual( [] );
	} );

	it( 'draw a source a file adds to a borrowed broker beside the include’s', () => {
		const graph = graphFromTsl(
			'include hub-base\n' +
				'command_node spokes:config add_source egret.p0 sink-q\n' +
				'command_node spokes:config add_source kea.p1 sink-k\n',
			{
				nodes: [
					{
						name: 'spokes',
						class: 'Remote_Source',
						args: [ 'tw0', 'o', 'd' ],
						fans_out: false,
						origin: [ 'hub-base' ],
						via: [ 'hub-base' ],
						verbs: [
							{
								verb: 'add_source',
								args: [ 'egret.p0', 'sink-q' ],
							},
						],
					},
				],
				edges: [ { from: 'spokes', to: 'sink-q', roles: [ 'pair' ] } ],
				tree: { 'hub-base': {} },
			},
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spokes', to: 'sink-k', roles: [ 'pair' ] },
			{ from: 'spokes', to: 'sink-q', roles: [ 'pair' ] },
		] );
	} );

	it( 'draw a claimed broker’s source once', () => {
		const graph = graphFromTsl(
			'include hub-base\n' +
				'make_node Remote_Source spokes tw0 o d\n' +
				'command_node spokes:config add_source egret.p0 sink-q\n',
			{
				nodes: [
					{
						name: 'spokes',
						class: 'Remote_Source',
						args: [ 'tw0', 'o', 'd' ],
						fans_out: false,
						origin: [ 'hub-base' ],
						via: [ 'hub-base' ],
						verbs: [
							{
								verb: 'add_source',
								args: [ 'egret.p0', 'sink-q' ],
							},
						],
					},
				],
				edges: [ { from: 'spokes', to: 'sink-q', roles: [ 'pair' ] } ],
				tree: { 'hub-base': {} },
			},
			brokerSchemas
		);

		expect( pairEdges( graph ) ).toEqual( [
			{ from: 'spokes', to: 'sink-q', roles: [ 'pair' ] },
		] );
	} );
} );
