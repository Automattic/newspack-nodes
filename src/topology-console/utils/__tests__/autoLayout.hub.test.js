/**
 * autoLayout over event-logger-nodes' hub worker: `hub-control`'s settings fan
 * from `settings-sync` and `discovery-collector` through one HTTP_Out per spoke
 * into `null`, the aggregator's `spokes` Remote_Sources fanning into
 * `php-errors:partition` and `remote-job-rewrite`, the `topicprobe` pair both
 * include, and the worker's two REPL cards.
 */

import { autoLayout, drawnCost, Y_STEP } from '../autoLayout';

/**
 * The hub worker's graph with `count` spokes.
 *
 * @param {number} count Spokes.
 * @return {{nodes: Array<{id: string}>, edges: Array<{from: string, to: string}>}} The graph.
 */
const hubWorker = ( count ) => {
	const pairs = [
		[ 'settings:consumer', 'settings-sync' ],
		[ 'settings-sync', 'settings' ],
		[ 'discovery-collector', 'settings' ],
		[ 'settings', 'null' ],
		[ 'topicprobe', 'topicprobe:log' ],
		[ 'php-errors:tail', 'php-errors:partition' ],
		[ 'spokes', 'php-errors:partition' ],
		[ 'spokes', 'remote-job-rewrite' ],
		[ 'remote-job-rewrite', 'firehose:topic' ],
	];
	for ( let i = 0; i < count; i++ ) {
		const spoke = `pub${ String( i ).padStart( 2, '0' ) }`;
		pairs.push(
			[ 'settings-sync', `settings:${ spoke }` ],
			[ 'discovery-collector', `settings:${ spoke }` ],
			[ `settings:${ spoke }`, 'null' ],
			[ `spokes:${ spoke }`, 'php-errors:partition' ],
			[ `spokes:${ spoke }`, 'remote-job-rewrite' ]
		);
	}
	const ids = new Set( [ '_repl', '_repl:input', ...pairs.flat() ] );
	return {
		nodes: [ ...ids ].map( ( id ) => ( { id } ) ),
		edges: pairs.map( ( [ from, to ] ) => ( { from, to } ) ),
	};
};

/**
 * Lay the hub worker out.
 *
 * @param {number} count Spokes.
 * @return {{at: Object<string,{x: number, y: number}>, edges: Array<{from: string, to: string}>}} Position by id, and the wires.
 */
const layOut = ( count ) => {
	const graph = hubWorker( count );
	return {
		at: Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		),
		edges: graph.edges,
	};
};

const BLOCKS = [
	[ 'topicprobe', 'topicprobe:log' ],
	[ '_repl', '_repl:input' ],
];
const SMALL = BLOCKS.flat();

describe.each( [ 11, 24 ] )(
	'autoLayout — the hub worker, %i spokes',
	( count ) => {
		it( 'seats the topicprobe chain one row under the settings chain', () => {
			const { at } = layOut( count );
			const head = at[ 'settings:consumer' ];
			expect( at.topicprobe ).toEqual( {
				x: head.x,
				y: head.y + Y_STEP,
			} );
			expect( at[ 'topicprobe:log' ] ).toEqual( {
				x: at[ 'settings-sync' ].x,
				y: head.y + Y_STEP,
			} );
		} );

		it( 'stacks the REPL cards over the settings chain, clear of discovery-collector’s row', () => {
			const { at } = layOut( count );
			const head = at[ 'settings:consumer' ];
			const above = at[ 'discovery-collector' ].y - Y_STEP;
			expect( [ at._repl, at[ '_repl:input' ] ] ).toEqual( [
				{ x: head.x, y: above - Y_STEP },
				{ x: head.x, y: above },
			] );
		} );

		it( 'keeps each small block nearer the canvas’s middle than either edge', () => {
			const { at } = layOut( count );
			const ys = Object.values( at ).map( ( p ) => p.y );
			const [ top, bottom ] = [ Math.min( ...ys ), Math.max( ...ys ) ];
			const mid = ( top + bottom ) / 2;
			for ( const ids of BLOCKS ) {
				const own = ids.map( ( id ) => at[ id ].y );
				const y = ( Math.min( ...own ) + Math.max( ...own ) ) / 2;
				const off = Math.abs( y - mid );
				expect( [ ids[ 0 ], off < y - top ] ).toEqual( [
					ids[ 0 ],
					true,
				] );
				expect( [ ids[ 0 ], off < bottom - y ] ).toEqual( [
					ids[ 0 ],
					true,
				] );
			}
		} );

		it( 'opens no column past the aggregator, the small cards left of null', () => {
			const { at } = layOut( count );
			const right = at[ 'firehose:topic' ].x;
			expect(
				Object.keys( at ).filter( ( id ) => at[ id ].x > right )
			).toEqual( [] );
			for ( const id of SMALL ) {
				expect( [ id, at[ id ].x < at.null.x ] ).toEqual( [
					id,
					true,
				] );
			}
		} );

		it( 'runs no drawn wire over a card', () => {
			const { at, edges } = layOut( count );
			expect( drawnCost( at, edges ).over ).toEqual( [] );
		} );
	}
);
