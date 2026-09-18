/**
 * Golden-fixture bake-off test for autoLayout.
 *
 * The firehose-workers-and-jobs graph (+ job-workers, requests/flame branches,
 * and the isolated _repl) has one ideal layout: the main component layered,
 * with the tee between `request-builder` and the partitions sitting clear of
 * the wires that run past it, the two side chains banded below it at their
 * own depth rather than reaching the partition column, and _repl under
 * everything. A layout is accepted iff its (col, row) grid matches the golden
 * grid AFTER:
 *   - normalizing global offset (min col / min row → 0), and
 *   - up to one vertical FLIP (row → maxRow − row), and/or
 *   - SWAPPING the `jobs:consumer → job-worker` row with the
 *     `requests:consumer → flame-builder → flames:partition` row.
 * Those are the only degrees of freedom; everything else is fixed.
 *
 * Columns are never flipped — sources-left / sinks-right orientation is fixed.
 */

import { autoLayout, X_STEP, Y_STEP } from '../autoLayout';

// Ideal layout (top-left positions) from the hand-verified live console. Only
// `completed:tee` sits in the column after `request-builder`, so no half step.
const GOLDEN = {
	'requests:partition': [ 1020, 520 ],
	'errors:partition': [ 1020, 410 ],
	'completed:tee': [ 780, 245 ],
	'completed:partition': [ 1020, 190 ],
	'gyroscope:partition': [ 1020, 300 ],
	'request-builder': [ 540, 410 ],
	'jobs:partition': [ 1020, 80 ],
	'job-router': [ 540, 80 ],
	'firehose:consumer': [ 60, 245 ],
	'firehose:tee': [ 300, 245 ],
	'jobintake:consumer': [ 300, 80 ],
	'flames:partition': [ 540, 630 ],
	'flame-builder': [ 300, 630 ],
	'requests:consumer': [ 60, 630 ],
	'job-worker': [ 300, 740 ],
	'jobs:consumer': [ 60, 740 ],
	_repl: [ 60, 850 ],
};

const EDGES = [
	[ 'completed:tee', 'completed:partition' ],
	[ 'completed:tee', 'gyroscope:partition' ],
	[ 'firehose:consumer', 'firehose:tee' ],
	[ 'firehose:tee', 'request-builder' ],
	[ 'firehose:tee', 'job-router' ],
	[ 'flame-builder', 'flames:partition' ],
	[ 'job-router', 'jobs:partition' ],
	[ 'jobintake:consumer', 'job-router' ],
	[ 'jobs:consumer', 'job-worker' ],
	[ 'request-builder', 'requests:partition' ],
	[ 'request-builder', 'errors:partition' ],
	[ 'request-builder', 'completed:tee' ],
	[ 'request-builder', 'gyroscope:partition' ],
	[ 'requests:consumer', 'flame-builder' ],
].map( ( [ from, to ] ) => ( { from, to } ) );

const IDS = Object.keys( GOLDEN );

// The two interchangeable rows (chains that may trade vertical slots).
const SWAP_A = [ 'jobs:consumer', 'job-worker' ];
const SWAP_B = [ 'requests:consumer', 'flame-builder', 'flames:partition' ];

// {id:[x,y]} → {id:{col,row}}, offset-normalized to topmost-leftmost (0,0).
function toGrid( positions ) {
	const xs = Object.values( positions ).map( ( p ) => p[ 0 ] );
	const ys = Object.values( positions ).map( ( p ) => p[ 1 ] );
	const minX = Math.min( ...xs );
	const minY = Math.min( ...ys );
	const g = {};
	for ( const id of Object.keys( positions ) ) {
		g[ id ] = {
			col: Math.round( ( positions[ id ][ 0 ] - minX ) / X_STEP ),
			row: ( positions[ id ][ 1 ] - minY ) / Y_STEP,
		};
	}
	return g;
}

const allRows = ( g ) => Object.values( g ).map( ( c ) => c.row );

function flipRows( g ) {
	const maxRow = Math.max( ...allRows( g ) );
	const o = {};
	for ( const id of Object.keys( g ) ) {
		o[ id ] = { col: g[ id ].col, row: maxRow - g[ id ].row };
	}
	return o;
}

function swapRows( g ) {
	const rowA = g[ SWAP_A[ 0 ] ].row;
	const rowB = g[ SWAP_B[ 0 ] ].row;
	const o = {};
	for ( const id of Object.keys( g ) ) {
		let { row } = g[ id ];
		if ( SWAP_A.includes( id ) ) {
			row = rowB;
		} else if ( SWAP_B.includes( id ) ) {
			row = rowA;
		}
		o[ id ] = { col: g[ id ].col, row };
	}
	return o;
}

// Best of the 4 accepted golden variants: the one matching the most nodes.
function bestMatch( candidate ) {
	const cand = toGrid( candidate );
	const base = toGrid( GOLDEN );
	const variants = {
		identity: base,
		flip: flipRows( base ),
		swap: swapRows( base ),
		flipSwap: flipRows( swapRows( base ) ),
	};
	let best = { transform: '', matched: -1, misses: IDS };
	for ( const [ transform, g ] of Object.entries( variants ) ) {
		const misses = IDS.filter(
			( id ) =>
				cand[ id ].col !== g[ id ].col ||
				Math.abs( cand[ id ].row - g[ id ].row ) > 0.01
		);
		if ( IDS.length - misses.length > best.matched ) {
			best = { transform, matched: IDS.length - misses.length, misses };
		}
	}
	return best;
}

describe( 'autoLayout — golden bake-off fixture', () => {
	it( 'reproduces the ideal firehose-workers layout (offset/flip/swap-invariant)', () => {
		const { nodes } = autoLayout( {
			nodes: IDS.map( ( id ) => ( { id } ) ),
			edges: EDGES,
		} );
		const positions = {};
		for ( const n of nodes ) {
			positions[ n.id ] = [ n.position.x, n.position.y ];
		}

		const result = bestMatch( positions );
		expect( {
			matched: result.matched,
			transform: result.transform,
			misses: result.misses,
		} ).toEqual( {
			matched: IDS.length,
			transform: result.transform,
			misses: [],
		} );
	} );
} );
