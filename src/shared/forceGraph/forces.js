/**
 * The force graph's placement and forces: pure layout math over a model.
 *
 * Each force is a function of `alpha` that adds velocity to leaves, in the
 * shape a d3 simulation takes. A branch has no velocity of its own: its box,
 * centre and radius follow its children through `updateBoxes`.
 */

import { hierarchy, pack, scaleLog } from 'd3';
import { HULL_PADDING } from './hulls';
import { docks } from './model';

/**
 * @typedef {import('./model').Leaf & {boxMinX: number, boxMaxX: number, boxMinY: number, boxMaxY: number}} BoxedLeaf
 * A leaf with the rect `boxLeaves` boxes it by.
 */

/**
 * @typedef {import('./model').Branch & {massX: number, massY: number}} MassBranch
 * A branch with the mass centre `updateBoxes` fits.
 */

/** The fixed charge of a graph without live rates. */
export const CHARGE = -1000;

/** Share of its distance to a branch's mass centre a leaf is pulled, per alpha. */
const COHESION = 0.1;

/** Multiplier from each ancestor to the next one up. */
const COHESION_FALLOFF = 0.9;

/** Distance from the canvas centre where its pull begins. */
const CENTER_FADE_START = 500;

/** Clear space siblings keep between their boxes; the push is zero at it. */
const GAP = 24;

/** Fastest a leaf moves, in pixels a tick. */
const MAX_VELOCITY = 100;

/** Repulsion of a live body: 1500 idle, 3000 at nine a second, and so on. */
const repulsionScale = scaleLog().range( [ 1500, 3000 ] );

/**
 * The charge a live body of the given rate carries. An idle one repels more
 * than the fixed charge does, because cohesion grows with alpha and a live
 * layout stays warm.
 *
 * @param {number} rate Messages a second.
 * @return {number} A negative charge, stronger for a busier body.
 */
export const chargeOf = ( rate ) => -repulsionScale( 1 + rate );

/**
 * Refit every branch's box, centre, radius and mass centre to its children.
 *
 * A leaf's box is its rect plus the hull padding, so the box a force sees
 * matches the hull on screen. A branch's mass centre weighs each child by its
 * population.
 *
 * @param {import('./model').Model} model The model.
 */
export const updateBoxes = ( model ) => {
	for ( const branch of model.branches ) {
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		let sumX = 0;
		let sumY = 0;
		for ( const child of branch.children ) {
			sumX += child.x * child.population;
			sumY += child.y * child.population;
			if ( 'branch' === child.type ) {
				minX = Math.min( minX, child.boxMinX );
				maxX = Math.max( maxX, child.boxMaxX );
				minY = Math.min( minY, child.boxMinY );
				maxY = Math.max( maxY, child.boxMaxY );
			} else {
				minX = Math.min( minX, child.x - child.halfW - HULL_PADDING );
				maxX = Math.max( maxX, child.x + child.halfW + HULL_PADDING );
				minY = Math.min( minY, child.y - child.halfH - HULL_PADDING );
				maxY = Math.max( maxY, child.y + child.halfH + HULL_PADDING );
			}
		}
		branch.boxMinX = minX;
		branch.boxMaxX = maxX;
		branch.boxMinY = minY;
		branch.boxMaxY = maxY;
		branch.x = ( minX + maxX ) / 2;
		branch.y = ( minY + maxY ) / 2;
		/** @type {MassBranch} */ ( branch ).massX = sumX / branch.population;
		/** @type {MassBranch} */ ( branch ).massY = sumY / branch.population;
		const halfW = ( maxX - minX ) / 2;
		const halfH = ( maxY - minY ) / 2;
		branch.radius = Math.sqrt( halfW * halfW + halfH * halfH );
	}
};

/**
 * Box every leaf by its rect, as siblings meet it. A branch's own box is
 * `updateBoxes`'s.
 *
 * @param {import('./model').Model} model The model.
 */
export const boxLeaves = ( model ) => {
	const leaves = /** @type {BoxedLeaf[]} */ ( model.leaves );
	for ( const leaf of leaves ) {
		leaf.boxMinX = leaf.x - leaf.halfW;
		leaf.boxMaxX = leaf.x + leaf.halfW;
		leaf.boxMinY = leaf.y - leaf.halfH;
		leaf.boxMaxY = leaf.y + leaf.halfH;
	}
};

/**
 * Place every leaf as nested circles, since hulls leaving one pile would all
 * take the same axis, then fit the branch boxes to them.
 *
 * @param {import('./model').Model}         model Model whose leaves move.
 * @param {{width: number, height: number}} size  Canvas size.
 */
export const placeNodes = ( model, { width, height } ) => {
	const root = hierarchy( { children: model.siblings[ 0 ] }, ( body ) =>
		body.children?.length ? body.children : null
	).sum( ( body ) => ( 'leaf' === body.type ? 1 : 0 ) );
	pack()
		.radius( ( { data } ) =>
			'leaf' === data.type ? Math.sqrt( data.halfW * data.halfH ) : 0
		)
		.padding( HULL_PADDING )( root );

	const aspect = Math.sqrt( width / height );
	for ( const { data: leaf, x, y } of root.leaves() ) {
		if ( 'leaf' === leaf.type ) {
			leaf.x = width / 2 + ( x - root.x ) * aspect;
			leaf.y = height / 2 + ( y - root.y ) / aspect;
			leaf.vx = 0;
			leaf.vy = 0;
		}
	}
	updateBoxes( model );
};

/**
 * Pull every leaf toward each enclosing branch's mass centre, nearest first
 * and weaker for each higher one, and toward the canvas centre once it is
 * farther than the fade start, fading in over the same distance again.
 *
 * @param {import('./model').Model}         model Model whose leaves move.
 * @param {{width: number, height: number}} size  Canvas size.
 * @return {function(number): void} Force of `alpha`.
 */
export const forceCohesion =
	( model, { width, height } ) =>
	( alpha ) => {
		for ( const leaf of model.leaves ) {
			let strength = alpha * COHESION;
			for ( const body of leaf.ancestors ) {
				const ancestor = /** @type {MassBranch} */ ( body );
				leaf.vx += ( ancestor.massX - leaf.x ) * strength;
				leaf.vy += ( ancestor.massY - leaf.y ) * strength;
				strength *= COHESION_FALLOFF;
			}
			const dx = width / 2 - leaf.x;
			const dy = height / 2 - leaf.y;
			const fade =
				( Math.sqrt( dx * dx + dy * dy ) - CENTER_FADE_START ) /
				CENTER_FADE_START;
			strength *= Math.min( 1, Math.max( 0, fade ) );
			leaf.vx += dx * strength;
			leaf.vy += dy * strength;
		}
	};

/**
 * Part overlapping siblings (a branch by its box, a leaf by its rect) along
 * the nearest exit, half the way each, to the gap. The push is exactly zero at
 * the gap and ignores alpha, as `forceCollide` does, so the layout ends with
 * the boxes clear of each other. Siblings sorted by left edge test only the
 * neighbors their box can still reach in x. A branch's push moves all of its
 * leaves; its box is as `updateBoxes` last left it.
 *
 * @param {import('./model').Model} model Model whose leaves move.
 * @return {function(): void} Force.
 */
export const forceSiblings = ( model ) => {
	// Copies the force sorts, so the model's own sibling order never moves.
	const siblings =
		/** @type {( BoxedLeaf | import('./model').Branch )[][]} */ (
			model.siblings.map( ( bodies ) => [ ...bodies ] )
		);
	return () => {
		boxLeaves( model );

		for ( const bodies of siblings ) {
			bodies.sort( ( a, b ) => a.boxMinX - b.boxMinX );
			for ( let i = 0; i < bodies.length; i++ ) {
				const one = bodies[ i ];
				for ( let j = i + 1; j < bodies.length; j++ ) {
					const two = bodies[ j ];
					if ( two.boxMinX > one.boxMaxX + GAP ) {
						break;
					}
					// Each way `two` could move to clear `one`.
					const right = one.boxMaxX - two.boxMinX + GAP;
					const left = two.boxMaxX - one.boxMinX + GAP;
					const down = one.boxMaxY - two.boxMinY + GAP;
					const up = two.boxMaxY - one.boxMinY + GAP;
					const exit = Math.min( right, left, down, up );
					if ( exit <= 0 ) {
						continue;
					}

					const kick = exit / 2;
					let dx = 0;
					let dy = 0;
					if ( exit === right ) {
						dx = 1;
					} else if ( exit === left ) {
						dx = -1;
					} else if ( exit === down ) {
						dy = 1;
					} else {
						dy = -1;
					}
					for ( const leaf of one.leafNodes ) {
						leaf.vx -= dx * kick;
						leaf.vy -= dy * kick;
					}
					for ( const leaf of two.leafNodes ) {
						leaf.vx += dx * kick;
						leaf.vy += dy * kick;
					}
				}
			}
		}
	};
};

/**
 * Cut every leaf's speed to the maximum, keeping its heading.
 *
 * @param {import('./model').Model} model Model whose leaves move.
 * @return {function(): void} Force.
 */
export const forceClamp = ( model ) => () => {
	for ( const leaf of model.leaves ) {
		const speed = Math.sqrt( leaf.vx * leaf.vx + leaf.vy * leaf.vy );
		if ( speed > MAX_VELOCITY ) {
			leaf.vx *= MAX_VELOCITY / speed;
			leaf.vy *= MAX_VELOCITY / speed;
		}
	}
};

/**
 * Pin each docked leaf in rows under the rest, centred on their span, in the
 * host's order, GAP apart and GAP below; with nothing else standing, one row
 * hangs from the origin. Which leaves dock is read once, as the model is
 * built; their extents, which a refresh resizes, at each tick.
 *
 * @param {import('./model').Model} model Model whose leaves move.
 * @return {function(): void} Force.
 */
export const forceDock = ( model ) => {
	const docked = model.leaves.filter( ( { node } ) => docks( node ) );
	if ( ! docked.length ) {
		return () => {};
	}
	const rest = model.leaves.filter( ( { node } ) => ! docks( node ) );
	return () => {
		let [ halfW, halfH ] = [ 0, 0 ];
		for ( const leaf of docked ) {
			halfW = Math.max( halfW, leaf.halfW );
			halfH = Math.max( halfH, leaf.halfH );
		}
		const [ step, rise ] = [ 2 * halfW + GAP, 2 * halfH + GAP ];
		let [ left, right, bottom ] = [ Infinity, -Infinity, -Infinity ];
		for ( const { x, y, halfW: w, halfH: h } of rest ) {
			left = Math.min( left, x - w );
			right = Math.max( right, x + w );
			bottom = Math.max( bottom, y + h );
		}
		const across = rest.length
			? Math.max( 1, Math.floor( ( right - left + GAP ) / step ) )
			: docked.length;
		const [ middle, top ] = rest.length
			? [ ( left + right ) / 2, bottom + GAP ]
			: [ 0, 0 ];
		docked.forEach( ( leaf, place ) => {
			const row = Math.floor( place / across );
			const inRow = Math.min( across, docked.length - row * across );
			leaf.fx =
				middle + ( ( place % across ) - ( inRow - 1 ) / 2 ) * step;
			leaf.fy = top + halfH + row * rise;
		} );
	};
};
