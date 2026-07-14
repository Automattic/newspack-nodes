/**
 * A node's `origin` (which include provides it) exists only on the PARSED tsl —
 * dump_metadata nodes carry none. So in live mode the lock badge showed on first
 * paint and vanished on the next poll. Provenance has to come from the baseline,
 * the same place the hulls get it.
 */
import { stampOrigins } from '../stampOrigins';

describe( 'stampOrigins', () => {
	const membership = {
		performance: [ 'request-builder', 'shared-tee' ],
		'job-router': [ 'shared-tee' ],
	};

	it( 'stamps origin onto metadata nodes, which carry none of their own', () => {
		const graph = {
			nodes: [ { id: 'request-builder' }, { id: 'own-echo' } ],
			edges: [],
		};

		const { nodes } = stampOrigins( graph, membership );

		expect( nodes[ 0 ].origin ).toEqual( [ 'performance' ] );
		expect( nodes[ 1 ].origin ).toBeUndefined();
	} );

	it( 'gives a diamond-shared node every include that provides it', () => {
		const graph = { nodes: [ { id: 'shared-tee' } ], edges: [] };

		expect( stampOrigins( graph, membership ).nodes[ 0 ].origin ).toEqual( [
			'performance',
			'job-router',
		] );
	} );

	it( 'leaves the graph alone when nothing is included', () => {
		const graph = { nodes: [ { id: 'a' } ], edges: [] };
		expect( stampOrigins( graph, {} ) ).toBe( graph );
	} );

	it( 'does not mutate the node it stamps', () => {
		const node = { id: 'request-builder' };
		stampOrigins( { nodes: [ node ], edges: [] }, membership );
		expect( node.origin ).toBeUndefined();
	} );
} );
