/**
 * The force graph's untangling: bodies mirror or trade places with a sibling
 * when that cuts the crossings among the spans and shortens them.
 *
 * Untangling moves leaves directly, not through velocity. A move is one trade
 * or one mirror; a call earns a credit of span comparisons and runs moves
 * while any is left, so a large graph is untangled a few moves at a time.
 */

import { mean } from 'd3';
import { updateBoxes } from './forces';

/** Span comparisons a call earns, and the most credit that is kept. */
export const COMPARISONS_PER_CALL = 400000;

/** Pixels of span length that cost as much as one crossing. */
const SPAN_PER_CROSSING = 10000;

/** A move that changes nothing can cost a hair less; it must beat that. */
const ROUNDING = 1e-6;

/** Siblings nearest what a body links to that it may trade with. */
const RIVALS = 8;

/** Largest radius ratio between bodies that trade; a larger one would shove its new neighbors aside. */
const SIZE_RATIO = 2;

/**
 * Whether two spans cross: their bounding boxes meet and each straddles the
 * other's line. Spans sharing an end do not cross.
 *
 * @param {import('./model').Link} l A span.
 * @param {import('./model').Link} m Another span.
 * @return {boolean} True when they cross.
 */
export const crosses = ( l, m ) => {
	const { source: a, target: b } = l;
	const { source: c, target: d } = m;
	if (
		Math.max( a.x, b.x ) < Math.min( c.x, d.x ) ||
		Math.max( c.x, d.x ) < Math.min( a.x, b.x )
	) {
		return false;
	}
	if (
		Math.max( a.y, b.y ) < Math.min( c.y, d.y ) ||
		Math.max( c.y, d.y ) < Math.min( a.y, b.y )
	) {
		return false;
	}
	const abX = b.x - a.x;
	const abY = b.y - a.y;
	const cdX = d.x - c.x;
	const cdY = d.y - c.y;
	return (
		( abX * ( c.y - a.y ) - abY * ( c.x - a.x ) ) *
			( abX * ( d.y - a.y ) - abY * ( d.x - a.x ) ) <
			0 &&
		( cdX * ( a.y - c.y ) - cdY * ( a.x - c.x ) ) *
			( cdX * ( b.y - c.y ) - cdY * ( b.x - c.x ) ) <
			0
	);
};

/**
 * Move every leaf of a body.
 *
 * @param {import('./model').Body} body Body to move.
 * @param {number}                 dx   Pixels right.
 * @param {number}                 dy   Pixels down.
 */
const shift = ( body, dx, dy ) => {
	for ( const leaf of body.leafNodes ) {
		leaf.x += dx;
		leaf.y += dy;
	}
};

/**
 * Make an untangler for a model. Each call adds a credit of span comparisons,
 * never holding more than one call's worth, and runs moves while any credit
 * is left; a move's comparisons come off it, so a heavy move leaves a debt
 * that later calls repay by running nothing. The cursor is a body and a move
 * within it, so a call resumes mid-body; a body's partners are taken once, as
 * its first trade starts, and each move reads positions and box sums as it
 * starts. A call finishes at most one lap of bodies. The model is fixed for
 * the untangler's life, so a changed graph makes a new one.
 *
 * @param {import('./model').Model} model Model whose leaves move.
 * @return {?function(): void} Untangle: a few moves mirror or trade places. Null for a model with nothing movable.
 */
export const createUntangler = ( model ) => {
	const { spans, movable } = model;
	if ( ! movable.length ) {
		return null;
	}

	let body = 0;
	let step = 0;
	/** @type {?import('./model').Body[]} */
	let partnerList = null;
	let credit = 0;
	let compared = 0;
	// Which spans a tangle has counted, by place in `spans`; all clear between.
	const counted = new Uint8Array( spans.length );
	const place = new Map( spans.map( ( span, i ) => [ span, i ] ) );

	/**
	 * Crossings plus the length of the moved spans, each crossing counted
	 * once; stops counting at the limit.
	 *
	 * @param {import('./model').Link[]} moved Spans whose ends moved.
	 * @param {number}                   limit Cost to stop at.
	 * @return {number} Cost, at least the limit when stopped.
	 */
	const tangle = ( moved, limit = Infinity ) => {
		let cost = 0;
		for ( const { source, target } of moved ) {
			cost +=
				Math.hypot( target.x - source.x, target.y - source.y ) /
				SPAN_PER_CROSSING;
		}
		for ( const l of moved ) {
			counted[ place.get( l ) ] = 1;
			for ( let i = 0; i < spans.length; i++ ) {
				if ( ! counted[ i ] ) {
					compared++;
					if ( crosses( l, spans[ i ] ) ) {
						cost++;
					}
				}
			}
			if ( cost >= limit ) {
				break;
			}
		}
		for ( const l of moved ) {
			counted[ place.get( l ) ] = 0;
		}
		return cost;
	};

	/**
	 * Make a move, and undo it unless it cuts the cost by more than the
	 * rounding allowance.
	 *
	 * @param {import('./model').Link[]} moved Spans the move touches.
	 * @param {function(): void}         move  Makes the move.
	 * @param {function(): void}         undo  Takes it back.
	 */
	const keepIfBetter = ( moved, move, undo ) => {
		const target = tangle( moved ) - ROUNDING;
		move();
		if ( tangle( moved, target ) < target ) {
			updateBoxes( model );
		} else {
			undo();
		}
	};

	/**
	 * Swap two bodies' places, subtrees and all, if that cuts the cost.
	 *
	 * @param {import('./model').Body} one A body.
	 * @param {import('./model').Body} two Its sibling.
	 */
	const trade = ( one, two ) => {
		const dx = two.x - one.x;
		const dy = two.y - one.y;
		keepIfBetter(
			[ ...new Set( [ ...one.spans, ...two.spans ] ) ],
			() => {
				shift( one, dx, dy );
				shift( two, -dx, -dy );
			},
			() => {
				shift( one, -dx, -dy );
				shift( two, dx, dy );
			}
		);
	};

	/**
	 * Flip a branch about its box on one axis, if that cuts the cost.
	 *
	 * @param {import('./model').Branch} branch Branch to flip.
	 * @param {'x'|'y'}                  axis   Axis the flip reverses.
	 */
	const mirror = ( branch, axis ) => {
		const sum =
			'x' === axis
				? branch.boxMinX + branch.boxMaxX
				: branch.boxMinY + branch.boxMaxY;
		const flip = () => {
			for ( const leaf of branch.leafNodes ) {
				leaf[ axis ] = sum - leaf[ axis ];
			}
		};
		keepIfBetter( branch.spans, flip, flip );
	};

	/**
	 * The siblings a body may trade with: the nearest to what it links to,
	 * within the size ratio.
	 *
	 * @param {import('./model').Body}   one   A body.
	 * @param {import('./model').Body[]} peers Every sibling of its type, itself among them.
	 * @return {import('./model').Body[]} Rivals in the order to try them.
	 */
	const partners = ( one, peers ) => {
		const { neighbors } = one;
		const x = mean( neighbors, ( other ) => other.x );
		const y = mean( neighbors, ( other ) => other.y );
		const fits = ( other ) =>
			Math.max( one.radius, other.radius ) <=
			SIZE_RATIO * Math.min( one.radius, other.radius );
		return peers
			.filter( ( other ) => other !== one )
			.sort(
				( a, b ) =>
					Math.hypot( a.x - x, a.y - y ) -
					Math.hypot( b.x - x, b.y - y )
			)
			.slice( 0, RIVALS )
			.filter( fits );
	};

	/**
	 * Run the body's next move: a branch mirrors on each axis, then the body
	 * trades with each partner in turn, taken once as its first trade starts
	 * and kept until its turn ends.
	 *
	 * @param {{body: import('./model').Body, peers: import('./model').Body[]}} entry The body and its peers.
	 * @return {boolean} False when the body has no move left.
	 */
	const move = ( entry ) => {
		const one = entry.body;
		const axes = /** @type {( 'x' | 'y' )[]} */ (
			'branch' === one.type ? [ 'x', 'y' ] : []
		);
		if ( step < axes.length ) {
			mirror(
				/** @type {import('./model').Branch} */ ( one ),
				axes[ step ]
			);
			return true;
		}
		partnerList ??= partners( one, entry.peers );
		const partner = partnerList[ step - axes.length ];
		if ( ! partner ) {
			return false;
		}
		trade( one, partner );
		return true;
	};

	return () => {
		credit = Math.min(
			credit + COMPARISONS_PER_CALL,
			COMPARISONS_PER_CALL
		);
		let finished = 0;
		if ( credit > 0 ) {
			updateBoxes( model );
		}
		while ( credit > 0 && finished < movable.length ) {
			compared = 0;
			if ( move( movable[ body ] ) ) {
				step++;
			} else {
				body = ( body + 1 ) % movable.length;
				step = 0;
				partnerList = null;
				finished++;
			}
			credit -= compared;
		}
	};
};
