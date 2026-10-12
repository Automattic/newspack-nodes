/**
 * autoLayout over the eve `crawler` worker, whose Crawler owns the `crawler:seen`
 * Table it writes: the `topologies get crawler` reply, the `classes dump`
 * catalog and the worker's `dump_metadata` a live install answers. The seed
 * and the live graph each draw the Crawler without the Table, which opens
 * from the Crawler's Inspector instead.
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
	it.each( Object.keys( GRAPHS ) )(
		'lays the Crawler out without its owned Table (%s)',
		( which ) => {
			const at = layOut( GRAPHS[ which ]() );
			expect( at.crawler ).toBeDefined();
			expect( at[ 'crawler:seen' ] ).toBeUndefined();
		}
	);

	it( 'names the Table among the live Crawler row’s sidecars', () => {
		expect(
			GRAPHS.live().nodes.find( ( n ) => 'crawler' === n.id ).sidecars
		).toContainEqual( { name: 'crawler:seen', class: 'Table' } );
	} );

	it.each( Object.keys( GRAPHS ) )(
		'runs no drawn wire over a card (%s)',
		( which ) => {
			const graph = GRAPHS[ which ]();
			const at = layOut( graph );
			// The canvas draws no wire to a card it does not draw.
			const drawn = graph.edges.filter(
				( e ) => at[ e.from ] && at[ e.to ]
			);
			expect( drawnCost( at, drawn ).over ).toEqual( [] );
		}
	);
} );
