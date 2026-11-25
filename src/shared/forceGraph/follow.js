/**
 * What follows a changed graph: how a model's shape differs from the one
 * before it, what a model of the same shape takes over, where a new model's
 * leaves start, and which of them crowd a sibling.
 *
 * Shape is the nodes, which of them are centered, their charges, the links'
 * ends, distances and strengths, which links are loose and the tree of hulls.
 * Text, classes, weights and extents are not shape: a model takes those over in
 * place.
 */

import { boxLeaves, updateBoxes } from './forces';

/** @typedef {import('./model').Model} Model */
/** @typedef {import('./model').Leaf} Leaf */
/** @typedef {import('./model').Link} Link */
/** @typedef {import('./forces').BoxedLeaf|import('./model').Branch} Boxed */

/**
 * Links by their ends, their distance, their strength and whether they are
 * loose, parallel links told apart by their turn.
 *
 * @param {Link[]} links Links.
 * @return {Map<string, Link>} Links by key.
 */
const byEnds = ( links ) => {
	const turns = new Map();
	return new Map(
		links.map( ( link ) => {
			const { source, target, link: host } = link;
			const alike = JSON.stringify( [
				source.id,
				target.id,
				host.distance,
				host.strength,
				!! host.loose,
			] );
			const turn = turns.get( alike ) ?? 0;
			turns.set( alike, turn + 1 );
			return [ `${ turn } ${ alike }`, link ];
		} )
	);
};

/**
 * Bodies by id. A node may carry a hull's id, so leaves and branches take a
 * map each.
 *
 * @template {{id: string}} T
 * @param {T[]} bodies Leaves or branches.
 * @return {Map<string, T>} Bodies by id.
 */
const byId = ( bodies ) =>
	new Map( bodies.map( ( body ) => [ body.id, body ] ) );

/**
 * Whether two maps have the same keys.
 *
 * @param {Map<string, unknown>} one A map.
 * @param {Map<string, unknown>} two Another.
 * @return {boolean} True when each has every key of the other.
 */
const sameKeys = ( one, two ) =>
	one.size === two.size &&
	[ ...one.keys() ].every( ( key ) => two.has( key ) );

/**
 * Whether two leaves take up different room.
 *
 * @param {Leaf} one A leaf.
 * @param {Leaf} two Another.
 * @return {boolean} True when either extent differs.
 */
const resized = ( one, two ) =>
	one.halfW !== two.halfW || one.halfH !== two.halfH;

/**
 * Whether a model's hulls hold its survivors as the hulls before it did. A
 * hull in both models is under the same ones of the hulls in both, and a new
 * hull holds a leaf that is new or back: a removal that dissolves a hull, and
 * the return that forms it again, change nothing about the rest.
 *
 * @param {Model}             was       The model in place.
 * @param {Model}             next      The model that follows.
 * @param {Map<string, Leaf>} survivors Leaves in both, by id.
 * @return {boolean} True when nothing was regrouped.
 */
const sameHulls = ( was, next, survivors ) => {
	const before = byId( was.branches );
	const after = byId( next.branches );
	const under = ( branch, others ) =>
		JSON.stringify(
			[ ...branch.ancestors ].flatMap( ( { id } ) =>
				others.has( id ) ? [ id ] : []
			)
		);

	return next.branches.every( ( branch ) => {
		const old = before.get( branch.id );
		return old
			? under( old, after ) === under( branch, before )
			: ! branch.leafNodes.every( ( { id } ) => survivors.has( id ) );
	} );
};

/**
 * How a model's shape differs from the one it follows.
 *
 * @param {Model} was  The model in place.
 * @param {Model} next The model that follows.
 * @return {{same: boolean, sameSurvivors: boolean}} Whether the whole shape, and the surviving nodes with their hulls and the links among them, are as they were.
 */
export const compare = ( was, next ) => {
	const before = byId( was.leaves );
	const survivors = byId(
		next.leaves.filter( ( { id } ) => before.has( id ) )
	);
	const among = ( { links } ) =>
		byEnds(
			links.filter(
				( { source, target } ) =>
					survivors.has( source.id ) && survivors.has( target.id )
			)
		);

	const sameSurvivors =
		[ ...survivors.values() ].every( ( leaf ) => {
			const old = before.get( leaf.id );
			return (
				old.parent?.id === leaf.parent?.id &&
				!! old.node.center === !! leaf.node.center &&
				old.node.charge === leaf.node.charge
			);
		} ) &&
		sameKeys( among( was ), among( next ) ) &&
		sameHulls( was, next, survivors );

	return {
		same:
			sameSurvivors &&
			survivors.size === was.leaves.length &&
			survivors.size === next.leaves.length &&
			was.branches.length === next.branches.length,
		sameSurvivors,
	};
};

/**
 * Hand a model the host data and the extents of another of its shape.
 *
 * @param {Model} model The model in place.
 * @param {Model} next  A model of the same shape.
 * @return {Leaf[]} The leaves whose extents changed.
 */
export const refresh = ( model, next ) => {
	const nodes = byId( next.leaves );
	const grown = model.leaves.filter( ( leaf ) =>
		resized( leaf, nodes.get( leaf.id ) )
	);
	for ( const leaf of model.leaves ) {
		const { node, halfW, halfH, radius } = nodes.get( leaf.id );
		Object.assign( leaf, { node, halfW, halfH, radius } );
	}
	const branches = byId( next.branches );
	for ( const branch of model.branches ) {
		branch.group = branches.get( branch.id ).group;
	}
	const links = byEnds( next.links );
	for ( const [ key, link ] of byEnds( model.links ) ) {
		link.link = links.get( key ).link;
	}
	return grown;
};

/**
 * Give every new leaf a place, working out from the placed ones: beside the
 * first of its neighbors that has a place, else at the centre of the nearest
 * enclosing group the model in place draws, else at the centre of the canvas.
 *
 * @param {Set<Leaf>}                       fresh The leaves without a place.
 * @param {Model}                           was   The model in place.
 * @param {Model}                           next  The model that follows.
 * @param {{width: number, height: number}} size  Canvas size.
 */
const placeFresh = ( fresh, was, next, { width, height } ) => {
	updateBoxes( was );
	const branches = byId( was.branches );
	const placed = next.leaves.filter( ( leaf ) => ! fresh.has( leaf ) );

	const put = ( leaf, x, y ) => {
		Object.assign( leaf, { x, y } );
		fresh.delete( leaf );
		placed.push( leaf );
	};

	for ( let i = 0; fresh.size; i++ ) {
		if ( i === placed.length ) {
			const [ leaf ] = fresh;
			const around = [ ...leaf.ancestors ].find( ( { id } ) =>
				branches.has( id )
			);
			const centre = branches.get( around?.id );
			put( leaf, centre?.x ?? width / 2, centre?.y ?? height / 2 );
		}
		for ( const leaf of placed[ i ].neighbors ) {
			if ( fresh.has( leaf ) ) {
				const beside = leaf.neighbors.find(
					( other ) => ! fresh.has( other )
				);
				put( leaf, beside.x + beside.halfW + leaf.halfW, beside.y );
			}
		}
	}
};

/**
 * Start a model's leaves from the model it follows: a survivor where it was
 * and at its speed, a returning leaf at its last place and at rest, a new one
 * beside a neighbor.
 *
 * @param {Model}                               was  The model in place.
 * @param {Model}                               next The model that follows.
 * @param {Map<string, {x: number, y: number}>} seen Last places by node id; takes those of the model in place.
 * @param {{width: number, height: number}}     size Canvas size.
 * @return {{added: boolean, unsettled: Leaf[]}} Whether a leaf is new, and the leaves that are back or resized.
 */
export const carry = ( was, next, seen, size ) => {
	const before = byId( was.leaves );
	for ( const { id, x, y } of was.leaves ) {
		seen.set( id, { x, y } );
	}

	const fresh = new Set();
	const unsettled = [];
	for ( const leaf of next.leaves ) {
		const old = before.get( leaf.id );
		if ( ! seen.has( leaf.id ) ) {
			fresh.add( leaf );
			continue;
		}
		Object.assign( leaf, seen.get( leaf.id ) );
		leaf.vx = old?.vx ?? 0;
		leaf.vy = old?.vy ?? 0;
		if ( ! old || resized( old, leaf ) ) {
			unsettled.push( leaf );
		}
	}
	const added = fresh.size > 0;
	placeFresh( fresh, was, next, size );

	return { added, unsettled };
};

/**
 * Whether any of the leaves, or a hull around one, overlaps a sibling.
 *
 * @param {Leaf[]} leaves Leaves of the model.
 * @param {Model}  model  The model, whose boxes are fitted here.
 * @return {boolean} True on the first sibling overlapped.
 */
export const crowds = ( leaves, model ) => {
	updateBoxes( model );
	boxLeaves( model );
	return leaves.some( ( leaf ) =>
		[ leaf, ...leaf.ancestors ].some( ( body ) => {
			const one = /** @type {Boxed} */ ( body );
			const siblings = /** @type {Boxed[]} */ (
				body.parent?.children ?? model.siblings[ 0 ]
			);
			return siblings.some(
				( two ) =>
					two !== one &&
					one.boxMinX < two.boxMaxX &&
					two.boxMinX < one.boxMaxX &&
					one.boxMinY < two.boxMaxY &&
					two.boxMinY < one.boxMaxY
			);
		} )
	);
};
