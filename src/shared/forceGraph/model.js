/**
 * The force graph's model: the bodies a layout moves, the links that pull
 * them together and the spans that must not cross, built once from the host's
 * nodes, links and groups.
 *
 * A body is a leaf (one node) or a branch (a group that draws a hull). Bodies
 * nest, and only siblings collide, so the model hands the layout its sibling
 * lists, its movable bodies and each body's neighbors outside itself.
 */

/** Half the height of a label rect, in pixels. */
export const LABEL_HALF_H = 12;

/** Pixels per label character in the label rect. */
const LABEL_CHAR_W = 7;

/** Padding around a label's text within its rect. */
const LABEL_PAD = 16;

/** Narrowest label rect. */
const LABEL_MIN_W = 60;

/** Room beneath a sized node's circle for its label. */
const LABEL_BELOW = 25;

/** Child groups that make a group without nodes a branch. */
const MEETING_CHILDREN = 2;

/**
 * @typedef {Object} HostNode
 * @property {string}   id     Unique among nodes.
 * @property {string}   label  Text drawn in the node's rect.
 * @property {number=}  size   Circle radius; absent for a label body.
 * @property {number=}  scale  What its label is drawn at; 1 without one.
 * @property {?string=} group  Id of the group holding the node.
 * @property {boolean=} center Whether the layout holds it at the centre of the canvas.
 * @property {number=}  charge What it carries while the layout is not live, negative to repel; the layout's own without one.
 */

/**
 * @typedef {Object} HostLink
 * @property {string}   source   Id of a node.
 * @property {string}   target   Id of a node.
 * @property {number=}  distance Pixels it pulls its ends to; the layout's own without one.
 * @property {number=}  strength Share of its error it corrects each tick, per alpha; the layout's own without one.
 * @property {boolean=} loose    Whether it is drawn alone, taking no part in the layout.
 */

/**
 * @typedef {Object} HostGroup
 * @property {string}   id     Opaque, unique among groups.
 * @property {?string=} parent Id of the enclosing group.
 */

/**
 * @typedef {Object} Leaf
 * @property {'leaf'}    type       Body kind.
 * @property {string}    id         The node's id.
 * @property {HostNode}  node       The host node.
 * @property {number}    halfW      Half the body's width.
 * @property {number}    halfH      Half the body's height.
 * @property {number}    radius     Distance from centre to corner.
 * @property {number}    population Leaves in the body: one.
 * @property {?Branch}   parent     Enclosing branch.
 * @property {Set<Body>} ancestors  Every enclosing branch.
 * @property {Leaf[]}    leafNodes  The body's leaves: itself.
 * @property {Link[]}    spans      Spans touching the body.
 * @property {Leaf[]}    neighbors  Far ends of the spans leaving the body.
 * @property {number}    x          Centre.
 * @property {number}    y          Centre.
 * @property {number}    vx         Velocity.
 * @property {number}    vy         Velocity.
 * @property {number=}   fx         Where the layout holds it.
 * @property {number=}   fy         Where the layout holds it.
 */

/**
 * @typedef {Object} Branch
 * @property {'branch'}  type       Body kind.
 * @property {string}    id         `group:<group id>`.
 * @property {HostGroup} group      The host group.
 * @property {Body[]}    children   Child branches, then leaves.
 * @property {number}    population Leaves in the body.
 * @property {number}    depth      Enclosing branches.
 * @property {?Branch}   parent     Enclosing branch.
 * @property {Set<Body>} ancestors  Every enclosing branch.
 * @property {Leaf[]}    leafNodes  Every leaf in the body.
 * @property {Link[]}    spans      Spans touching the body.
 * @property {Leaf[]}    neighbors  Far ends of the spans leaving the body.
 * @property {number}    x          Centre.
 * @property {number}    y          Centre.
 * @property {number}    radius     Hull radius.
 * @property {number}    boxMinX    Hull box.
 * @property {number}    boxMaxX    Hull box.
 * @property {number}    boxMinY    Hull box.
 * @property {number}    boxMaxY    Hull box.
 */

/** @typedef {Leaf|Branch} Body */

/**
 * @typedef {Object} Link
 * @property {Leaf}     source The link's source leaf.
 * @property {Leaf}     target The link's target leaf.
 * @property {HostLink} link   The host link.
 */

/**
 * @typedef {Object} Model
 * @property {Leaf[]}                        leaves   One for each node.
 * @property {Branch[]}                      branches One for each group that draws a hull, deepest first.
 * @property {Map<string, Leaf>}             byId     Leaves by node id.
 * @property {Body[][]}                      siblings Top-level bodies, then each branch's children.
 * @property {Link[]}                        links    Every drawable link.
 * @property {Link[]}                        pulls    The links whose ends share a parent, loose ones aside.
 * @property {Link[]}                        spans    One link for each linked pair, loose ones aside.
 * @property {{body: Body, peers: Body[]}[]} movable  Each sibling with a neighbor outside itself, and every sibling of its type, itself among them; a center node, and a body that holds one, is neither.
 */

/**
 * Half the width of a label's rect.
 *
 * @param {string} label The node's label.
 * @return {number} Half width in pixels.
 */
export const labelHalfW = ( label ) =>
	Math.max( label.length * LABEL_CHAR_W + LABEL_PAD, LABEL_MIN_W ) / 2;

/**
 * Whether a leaf lies within a body.
 *
 * @param {Body} body Leaf or branch.
 * @param {Leaf} leaf Leaf to place.
 * @return {boolean} True when the leaf is the body or one of its descendants.
 */
const holds = ( body, leaf ) => body === leaf || leaf.ancestors.has( body );

/**
 * A leaf for one node: its label's rect at its scale, or a sized node's circle
 * with room beneath it for the label.
 *
 * @param {HostNode} node Host node.
 * @return {Leaf} Leaf at the origin.
 */
const makeLeaf = ( node ) => {
	const { size, scale = 1 } = node;
	const labelW = labelHalfW( node.label ) * scale;
	const halfW = size ? Math.max( size, labelW ) : labelW;
	const halfH = size ? size + LABEL_BELOW * scale : LABEL_HALF_H * scale;

	return {
		type: 'leaf',
		id: node.id,
		node,
		halfW,
		halfH,
		radius: Math.hypot( halfW, halfH ),
		population: 1,
		parent: null,
		ancestors: new Set(),
		leafNodes: [],
		spans: [],
		neighbors: [],
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
	};
};

/**
 * A branch for one group.
 *
 * @param {HostGroup} group Host group.
 * @return {Branch} Empty branch at the origin.
 */
const makeBranch = ( group ) => ( {
	type: 'branch',
	id: `group:${ group.id }`,
	group,
	children: [],
	population: 0,
	depth: 0,
	parent: null,
	ancestors: new Set(),
	leafNodes: [],
	spans: [],
	neighbors: [],
	x: 0,
	y: 0,
	radius: 0,
	boxMinX: 0,
	boxMaxX: 0,
	boxMinY: 0,
	boxMaxY: 0,
} );

/**
 * Whether a group names a parent.
 *
 * @param {HostGroup} group Host group.
 * @return {boolean} False for a null or absent parent.
 */
const hasParent = ( group ) =>
	null !== group.parent && undefined !== group.parent;

/**
 * Index the groups by id, refusing a duplicate id, a parent that names no
 * group, and a parent chain that returns to a group it left.
 *
 * @param {HostGroup[]} groups Host groups.
 * @return {Map<string, HostGroup>} Host groups by id.
 */
const indexGroups = ( groups ) => {
	const groupById = new Map();
	for ( const group of groups ) {
		if ( groupById.has( group.id ) ) {
			throw new Error( `force graph: duplicate group "${ group.id }"` );
		}
		groupById.set( group.id, group );
	}
	for ( const group of groups ) {
		if ( hasParent( group ) && ! groupById.has( group.parent ) ) {
			throw new Error(
				`force graph: unknown parent group "${ group.parent }"`
			);
		}
	}

	// A chain reaching a cleared group ends cleanly: each is walked once.
	const cleared = new Set();
	for ( const start of groups ) {
		const walking = new Set();
		let group = start;
		while ( group && ! cleared.has( group.id ) ) {
			if ( walking.has( group.id ) ) {
				throw new Error(
					`force graph: group parent cycle at "${ group.id }"`
				);
			}
			walking.add( group.id );
			group = hasParent( group )
				? groupById.get( group.parent )
				: undefined;
		}
		walking.forEach( ( id ) => cleared.add( id ) );
	}

	return groupById;
};

/**
 * The groups that draw a branch: those holding a node, and those where two
 * child groups meet. A group with no node anywhere beneath it draws nothing
 * and is not counted where child groups meet.
 *
 * @param {HostNode[]}             nodes     Host nodes.
 * @param {HostGroup[]}            groups    Host groups.
 * @param {Map<string, HostGroup>} groupById Host groups by id.
 * @return {HostGroup[]} Groups in host order.
 */
const branchGroups = ( nodes, groups, groupById ) => {
	const held = new Set( nodes.map( ( node ) => node.group ) );
	const populated = new Set();
	for ( const id of held ) {
		for (
			let group = groupById.get( id );
			group && ! populated.has( group.id );
			group = hasParent( group ) ? groupById.get( group.parent ) : null
		) {
			populated.add( group.id );
		}
	}
	const childCount = new Map();
	for ( const { id, parent } of groups ) {
		if ( populated.has( id ) ) {
			childCount.set( parent, ( childCount.get( parent ) ?? 0 ) + 1 );
		}
	}

	return groups.filter(
		( { id } ) =>
			held.has( id ) || ( childCount.get( id ) ?? 0 ) >= MEETING_CHILDREN
	);
};

/**
 * Nest the bodies: each branch under its nearest enclosing branch, each leaf
 * under its group's branch, with ancestors, depth, population and leaf lists.
 *
 * @param {Leaf[]}                 leaves    Leaves, in node order.
 * @param {Branch[]}               branches  Branches, in group order; left deepest first.
 * @param {Map<string, HostGroup>} groupById Host groups by id.
 * @param {Map<string, Branch>}    branchOf  Branches by group id.
 */
const nest = ( leaves, branches, groupById, branchOf ) => {
	const enclosing = ( group ) => {
		let id = group.parent;
		while ( null !== id && undefined !== id ) {
			const found = branchOf.get( id );
			if ( found ) {
				return found;
			}
			id = groupById.get( id ).parent;
		}
		return null;
	};

	for ( const branch of branches ) {
		branch.parent = enclosing( branch.group );
	}

	const place = ( body ) => {
		for ( let p = body.parent; p; p = p.parent ) {
			body.ancestors.add( p );
		}
		body.parent?.children.push( body );
	};
	branches.forEach( place );
	leaves.forEach( place );

	// Deepest first, so a branch reads its children after they are finished.
	for ( const branch of branches ) {
		branch.depth = branch.ancestors.size;
	}
	branches.sort( ( a, b ) => b.depth - a.depth );
	for ( const leaf of leaves ) {
		leaf.leafNodes = [ leaf ];
	}
	for ( const branch of branches ) {
		branch.population = branch.children.reduce(
			( sum, child ) => sum + child.population,
			0
		);
		branch.leafNodes = branch.children.flatMap(
			( child ) => child.leafNodes
		);
	}
};

/**
 * Give every body the spans touching it and the leaves those spans reach
 * outside it, walking each span up its two ends' ancestors once.
 *
 * @param {Link[]} spans One link for each linked pair.
 */
const reach = ( spans ) => {
	for ( const span of spans ) {
		const { source, target } = span;
		for ( const [ end, other ] of [
			[ source, target ],
			[ target, source ],
		] ) {
			for ( const body of [ end, ...end.ancestors ] ) {
				if ( ! holds( body, other ) ) {
					body.spans.push( span );
					body.neighbors.push( other );
				} else if ( end === source ) {
					body.spans.push( span );
				}
			}
		}
	}
};

/**
 * Build the model a force layout moves.
 *
 * A group id is opaque: parentage is a group's `parent`, never read from its
 * id. A group draws a branch when it holds a node or where two child groups
 * meet; a node without a group is a top-level sibling.
 *
 * @param {{nodes: HostNode[], links: HostLink[], groups: HostGroup[]}} graph Host data.
 * @return {Model} The model.
 */
export const buildModel = ( { nodes, links, groups } ) => {
	const groupById = indexGroups( groups );
	for ( const { group } of nodes ) {
		if (
			null !== group &&
			undefined !== group &&
			! groupById.has( group )
		) {
			throw new Error( `force graph: unknown group "${ group }"` );
		}
	}

	const leaves = nodes.map( makeLeaf );
	const nodeIds = new Set();
	for ( const { id } of nodes ) {
		if ( nodeIds.has( id ) ) {
			throw new Error( `force graph: duplicate node "${ id }"` );
		}
		nodeIds.add( id );
	}
	const branches = branchGroups( nodes, groups, groupById ).map( makeBranch );
	const branchOf = new Map( branches.map( ( b ) => [ b.group.id, b ] ) );
	const byId = new Map( leaves.map( ( leaf ) => [ leaf.id, leaf ] ) );

	for ( const leaf of leaves ) {
		leaf.parent = branchOf.get( leaf.node.group ) ?? null;
	}
	nest( leaves, branches, groupById, branchOf );

	const drawn = links.flatMap( ( link ) => {
		const source = byId.get( link.source );
		const target = byId.get( link.target );
		return source && target ? [ { source, target, link } ] : [];
	} );
	const laidOut = drawn.filter( ( { link } ) => ! link.loose );

	// A pair linked many times, either way, is one span; a self link has none.
	const pairs = new Map();
	for ( const link of laidOut ) {
		if ( link.source !== link.target ) {
			const key = JSON.stringify(
				[ link.source.id, link.target.id ].sort()
			);
			pairs.set( key, pairs.get( key ) ?? link );
		}
	}
	const spans = [ ...pairs.values() ];
	reach( spans );

	const pulls = laidOut.filter(
		( { source, target } ) =>
			source !== target && source.parent === target.parent
	);

	const siblings = [
		[ ...branches, ...leaves ].filter( ( body ) => ! body.parent ),
		...branches.map( ( branch ) => branch.children ),
	];
	const isFree = ( { leafNodes } ) =>
		! leafNodes.some( ( { node } ) => node.center );
	const movable = siblings.flatMap( ( all ) => {
		const bodies = all.filter( isFree );
		// Shared by its bodies, so a list of any length is walked once.
		const peers = { leaf: [], branch: [] };
		bodies.forEach( ( body ) => peers[ body.type ].push( body ) );
		return bodies
			.filter( ( body ) => body.neighbors.length )
			.map( ( body ) => ( { body, peers: peers[ body.type ] } ) );
	} );

	return {
		leaves,
		branches,
		byId,
		siblings,
		links: drawn,
		pulls,
		spans,
		movable,
	};
};
