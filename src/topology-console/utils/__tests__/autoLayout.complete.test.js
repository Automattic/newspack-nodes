/**
 * autoLayout over event-logger-nodes' `complete` worker as the console first
 * paints it: the `topologies get complete` reply and the `classes dump`
 * catalog a live install answered, composed by the same four calls
 * `useConsoleGraph` makes before the worker's own `dump_metadata` lands —
 * `graphFromTsl`, `withResolvedConfigEdges`, `withReplAnchor` and
 * `augmentWithVirtualEdges`.
 */

import { graphFromTsl } from '../draftToGraph';
import { withReplAnchor, withResolvedConfigEdges } from '../consoleGraph';
import { augmentWithVirtualEdges } from '../virtualEdges';
import { autoLayout, drawnCost, Y_STEP } from '../autoLayout';
import SEED from './fixtures/eln-complete-seed.json';

/**
 * The graph `useConsoleGraph` seeds `_metadata` with for the worker.
 *
 * @return {{nodes: Array<{id: string}>, edges: Array<{from: string, to: string}>}} The graph.
 */
const seededGraph = () =>
	augmentWithVirtualEdges(
		withReplAnchor(
			withResolvedConfigEdges(
				graphFromTsl(
					SEED.tsl,
					SEED.expanded,
					SEED.classes,
					SEED.resolved_config_edges
				),
				SEED.resolved_config_edges
			)
		),
		SEED.classes
	);

/**
 * Lay the seeded graph out.
 *
 * @return {{at: Object<string,{x: number, y: number}>, edges: Array<{from: string, to: string}>}} Position by id, and the wires.
 */
const layOut = () => {
	const graph = seededGraph();
	return {
		at: Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		),
		edges: graph.edges,
	};
};

/**
 * Every card weakly connected to `from`.
 *
 * @param {Array<{from: string, to: string}>} edges The wires.
 * @param {string}                            from  The card to start at.
 * @return {Set<string>} The component.
 */
const componentOf = ( edges, from ) => {
	const seen = new Set( [ from ] );
	for ( let grew = true; grew;  ) {
		grew = false;
		for ( const e of edges ) {
			if ( seen.has( e.from ) !== seen.has( e.to ) ) {
				seen.add( seen.has( e.from ) ? e.to : e.from );
				grew = true;
			}
		}
	}
	return seen;
};

const CHAINS = [
	[ 'jobs:consumer', 'job-worker' ],
	[ 'jobstats', 'jobstats:log' ],
	[ 'tablestats', 'tablestats:log' ],
	[ 'topicprobe', 'topicprobe:log' ],
];

describe( 'autoLayout — the event logger’s complete worker', () => {
	it( 'lays out every card the seeded graph holds', () => {
		const { at } = layOut();
		expect( Object.keys( at ).sort() ).toEqual(
			seededGraph()
				.nodes.map( ( n ) => n.id )
				.sort()
		);
	} );

	it( 'seats the REPL singletons in column 0, above firehose:consumer', () => {
		const { at } = layOut();
		const head = at[ 'firehose:consumer' ];
		for ( const id of [ '_repl', '_repl:input' ] ) {
			expect( [ id, at[ id ].x ] ).toEqual( [ id, head.x ] );
			expect( [ id, at[ id ].y < head.y ] ).toEqual( [ id, true ] );
		}
		// The canvas's top two rows, clear of the wire column 1 carries.
		const top = Math.min( ...Object.values( at ).map( ( p ) => p.y ) );
		expect( [ at._repl.y, at[ '_repl:input' ].y ] ).toEqual( [
			top,
			top + Y_STEP,
		] );
	} );

	it( 'stacks the topicprobe chain at the bottom with the other three', () => {
		const { at } = layOut();
		const ys = CHAINS.map( ( [ head ] ) => at[ head ].y );
		expect(
			new Set( CHAINS.map( ( [ head ] ) => at[ head ].x ) ).size
		).toBe( 1 );
		expect(
			new Set( CHAINS.map( ( [ , tail ] ) => at[ tail ].x ) ).size
		).toBe( 1 );
		const step = ys[ 1 ] - ys[ 0 ];
		expect( step ).toBeGreaterThan( 0 );
		expect( ys ).toEqual( ys.map( ( _, k ) => ys[ 0 ] + k * step ) );
		const bottom = Math.max( ...Object.values( at ).map( ( p ) => p.y ) );
		expect( at.topicprobe.y ).toBe( bottom );
	} );

	it( 'opens no column past the main block’s last', () => {
		const { at, edges } = layOut();
		const main = componentOf( edges, 'firehose:consumer' );
		const last = Math.max( ...[ ...main ].map( ( id ) => at[ id ].x ) );
		expect(
			Object.keys( at ).filter( ( id ) => at[ id ].x > last )
		).toEqual( [] );
	} );

	it( 'runs no drawn wire over a card', () => {
		const { at, edges } = layOut();
		expect( drawnCost( at, edges ).over ).toEqual( [] );
	} );
} );
