import { Core } from '../../../runtime/core';
import { Node } from '../../../runtime/node';
import { coreToGraph } from '../coreToGraph';
import {
	parseMetadata,
	dumpMetadataPayload,
} from '../../../runtime/metadata-node';

describe( 'coreToGraph', () => {
	beforeEach( () => Core.reset() );

	it( 'produces the SAME graph as parseMetadata over the live payload', () => {
		const a = new Node();
		a.name = 'a';
		a.target = 'b';
		a.counter = 3;
		const b = new Node();
		b.name = 'b';
		expect( coreToGraph() ).toEqual(
			parseMetadata( dumpMetadataPayload() )
		);
	} );

	it( 'draws an edge from a node target and hides the backbone', () => {
		const interpreter = new Node();
		interpreter.name = '_command_interpreter';
		const a = new Node();
		a.name = 'a';
		a.target = 'b';
		const b = new Node();
		b.name = 'b';
		const { nodes, edges } = coreToGraph();
		expect( nodes.map( ( n ) => n.id ) ).toEqual( [ 'a', 'b' ] );
		expect( edges ).toEqual( [ { from: 'a', to: 'b' } ] );
	} );
} );
