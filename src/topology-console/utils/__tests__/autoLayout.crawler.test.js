/**
 * autoLayout over the eve `crawler` worker, whose Crawler owns the `crawler:seen`
 * Table it writes: the `topologies get crawler` reply, the `classes dump`
 * catalog and the worker's `dump_metadata` a live install answered. The seed
 * and the live graph each lay the Table out beside its owner.
 */

import { autoLayout, drawnCost } from '../autoLayout';
import { augmentWithVirtualEdges } from '../virtualEdges';
import { parseMetadata } from '../../../runtime/metadata-node';
import { seededGraph } from './fixtures/seededGraph';
import SEED from './fixtures/crawler-seed.json';

/**
 * Lay a graph out.
 *
 * @param {{nodes: Array<{id: string}>, edges: Array<{from: string, to: string}>}} graph The graph.
 * @return {Object<string,{x: number, y: number}>} Position by id.
 */
const layOut = ( graph ) =>
	Object.fromEntries(
		autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
	);

const GRAPHS = {
	seed: () => seededGraph( SEED ),
	live: () =>
		augmentWithVirtualEdges( parseMetadata( SEED.metadata ), SEED.classes ),
};

describe( 'autoLayout — the crawler worker and its owned Table', () => {
	it( 'seeds the owned Table, owned by and wired from its owner', () => {
		const graph = GRAPHS.seed();
		expect(
			graph.nodes.find( ( n ) => 'crawler:seen' === n.id )
		).toMatchObject( { class: 'Table', owner: 'crawler' } );
		expect( graph.edges ).toContainEqual( {
			from: 'crawler',
			to: 'crawler:seen',
			roles: [ 'extra' ],
		} );
	} );

	it.each( Object.keys( GRAPHS ) )(
		'seats crawler:seen in a column after crawler’s (%s)',
		( which ) => {
			const at = layOut( GRAPHS[ which ]() );
			expect( at[ 'crawler:seen' ].x ).toBeGreaterThan( at.crawler.x );
		}
	);

	it.each( Object.keys( GRAPHS ) )(
		'runs no drawn wire over a card (%s)',
		( which ) => {
			const graph = GRAPHS[ which ]();
			expect( drawnCost( layOut( graph ), graph.edges ).over ).toEqual(
				[]
			);
		}
	);
} );
