/**
 * The force graph's drawing: the elements d3 joins to a model, keyed by id,
 * and where each one stands.
 */

import { min, polygonCentroid, polygonContains, scaleLog, select } from 'd3';
import { classes } from '../components/Modal';
import { hullPoints } from './hulls';
import { circleRadius } from './model';

/** The class every part of the graph is named from. */
export const BLOCK = 'newspack-nodes-force-graph';

/** Opacity of a line with a rate, while the rate is zero and above it. */
const IDLE_OPACITY = 0.25;
const LIT_OPACITY = 0.9;

/** Pixels from a circle to its label's baseline. */
const LABEL_RISE = 8;

/** Pixels from a hull to its label's baseline. */
const HULL_LABEL_RISE = 8;

/** Drop from a text's middle to its baseline. */
const MIDDLE_DROP = 4;

/** Width of a line's stroke: 1 idle, 3 at ten times as much, and so on. */
const strokeScale = scaleLog().range( [ 1, 3 ] );

/** @typedef {import('./model').Model} Model */
/** @typedef {import('./model').Link} Link */
/** @typedef {import('./ForceGraph').GraphNode} GraphNode */
/** @typedef {import('./ForceGraph').GraphLink} GraphLink */
/** @typedef {import('./ForceGraph').ForceGraphProps} ForceGraphProps */

/**
 * The width of a line.
 *
 * @param {GraphLink} link The line.
 * @return {number} Width in the graph's own units.
 */
const strokeOf = ( { weight = 0, rate = 0 } ) =>
	strokeScale( 1 + Math.max( weight, rate ) );

/**
 * The opacity of a line, which one without a rate leaves to its classes.
 *
 * @param {GraphLink} link The line.
 * @return {?number} The opacity, or null.
 */
const opacityOf = ( { rate } ) => {
	if ( undefined === rate ) {
		return null;
	}
	return rate > 0 ? LIT_OPACITY : IDLE_OPACITY;
};

/**
 * d3_visualizer.html's target arc, a radius as long as the chord between the
 * centres, stopped where it meets the target: as far from the target's centre
 * as a straight line would stop, back along the arc, so its end points in.
 *
 * @param {{x: number, y: number}} source The source's centre.
 * @param {{x: number, y: number}} target The target's centre.
 * @param {number}                 back   Share of the chord within the target.
 * @return {string} The path's `d`.
 */
const arcPath = ( source, target, back ) => {
	const dx = target.x - source.x;
	const dy = target.y - source.y;
	const r = Math.hypot( dx, dy );
	const half = Math.sqrt( 3 ) / 2;
	// The arc's centre: the third corner of an equilateral triangle.
	const cx = source.x + dx / 2 - dy * half;
	const cy = source.y + dy / 2 + dx * half;
	const turn = -2 * Math.asin( back / 2 );
	const [ tx, ty ] = [ target.x - cx, target.y - cy ];
	const x = cx + tx * Math.cos( turn ) - ty * Math.sin( turn );
	const y = cy + tx * Math.sin( turn ) + ty * Math.cos( turn );
	return `M${ source.x },${ source.y }A${ r },${ r } 0 0,1 ${ x },${ y }`;
};

/**
 * A line's path: from its source's centre to the edge of its target,
 * straight, or as an arc when the line is curved.
 *
 * @param {Link} link The line.
 * @return {string} The path's `d`.
 */
const linkPath = ( { source, target, link } ) => {
	const dx = target.x - source.x;
	const dy = target.y - source.y;
	// The share of the line that lies within its target.
	const within = target.node.size
		? circleRadius( target.node ) / Math.hypot( dx, dy )
		: Math.min(
				target.halfW / Math.abs( dx ),
				target.halfH / Math.abs( dy )
		  );
	const back = Math.min( within, 1 );
	if ( link.curved ) {
		return arcPath( source, target, back );
	}
	const [ x, y ] = [ target.x - dx * back, target.y - dy * back ];
	return `M${ source.x },${ source.y }L${ x },${ y }`;
};

/**
 * Keep one child of a kind in each parent that wants it.
 *
 * @param {Object}              parents  Selection of the parents.
 * @param {string}              tag      The child's tag.
 * @param {string}              part     What the child is of the graph.
 * @param {function(Object): *} wants    Whether a parent's datum wants it.
 * @param {string}              [before] Selector of the sibling it precedes; last without one.
 * @return {Object} Selection of the children, each with its parent's datum.
 */
const keep = ( parents, tag, part, wants, before ) =>
	parents
		.selectChildren( `${ tag }.${ BLOCK }__${ part }` )
		.data( ( datum ) => ( wants( datum ) ? [ datum ] : [] ) )
		.join( ( enter ) =>
			enter.insert( tag, before ).attr( 'class', `${ BLOCK }__${ part }` )
		);

/**
 * Where a node's label stands, before its scale: in the middle of its rect, or
 * clear above its circle.
 *
 * @param {GraphNode} node The node.
 * @return {number} The baseline.
 */
const labelY = ( node ) =>
	node.size
		? ( -circleRadius( node ) - LABEL_RISE ) / ( node.scale ?? 1 )
		: MIDDLE_DROP;

/** Wants for `keep`. */
const all = () => true;
const sized = ( { node } ) => node.size;
const unsized = ( { node } ) => ! node.size;
const titled = ( { link } ) => link.title;

/**
 * Draw on an svg.
 *
 * @param {SVGSVGElement} svg     The svg, empty.
 * @param {string}        arrowId Id of its arrowhead, unique in the document.
 */
export const createDrawing = ( svg, arrowId ) => {
	const root = select( svg );
	const layer = ( parent, part ) =>
		parent.append( 'g' ).attr( 'class', `${ BLOCK }__${ part }` );

	root.append( 'defs' )
		.append( 'marker' )
		.attr( 'id', arrowId )
		.attr( 'viewBox', '0 -5 10 10' )
		.attr( 'refX', 10 )
		.attr( 'markerWidth', 6 )
		.attr( 'markerHeight', 6 )
		.attr( 'orient', 'auto' )
		.append( 'path' )
		.attr( 'class', `${ BLOCK }__arrow` )
		.attr( 'd', 'M0,-5L10,0L0,5' );
	const view = layer( root, 'view' );
	let hulls = layer( view, 'hulls' ).selectChildren();
	let links = layer( view, 'links' ).selectChildren();
	let hits = layer( view, 'hits' ).selectChildren();
	let nodes = layer( view, 'nodes' ).selectChildren();
	// Each hull's outline as painted, outermost first.
	let outlines = [];
	// The line under each target for a press.
	/** @type {Element[]} */
	let aimed = [];
	// The scale the view draws at, which a landmark's label alone reads.
	let zoom = 1;

	/** Tell each landmark's label the scale, and no other element. */
	const holdZoom = () =>
		nodes
			.filter( ( { node } ) => node.landmark )
			.select( `.${ BLOCK }__label` )
			.style( '--force-graph-zoom', zoom );

	/** @param {ForceGraphProps} host The host's props. */
	const dressNodes = ( { selectedId, hoveredId, onSelect } ) => {
		nodes.attr( 'class', ( { id, node } ) =>
			classes(
				`${ BLOCK }__node`,
				node.className,
				node.rate > 0 && 'is-live',
				node.landmark && 'is-landmark',
				onSelect && 'is-pressable',
				id === selectedId && 'is-selected',
				id === hoveredId && 'is-hovered'
			)
		);
		holdZoom();
	};

	/** Lay each target for a press over its line, as that is painted. */
	const placeHits = () =>
		hits.attr( 'd', ( _, i ) => aimed[ i ].getAttribute( 'd' ) );

	/** @param {ForceGraphProps} host The host's props. */
	const dressLinks = ( { selectedLink, onSelectLink } ) => {
		const takesPress = ( { link } ) =>
			!! onSelectLink && false !== link.pressable;
		links.attr( 'class', ( datum ) =>
			classes(
				`${ BLOCK }__link`,
				datum.link.className,
				datum.link.rate > 0 && 'is-live',
				takesPress( datum ) && 'is-pressable',
				datum.link.id === selectedLink && 'is-selected'
			)
		);

		const pressed = links.filter( takesPress );
		aimed = pressed.nodes();
		hits = hits
			.data( pressed.data(), ( { link } ) => link.id )
			.join( 'path' )
			.attr( 'class', `${ BLOCK }__hit` )
			.attr( 'aria-hidden', 'true' );
		keep( hits, 'title', 'title', titled ).text(
			( { link } ) => link.title
		);
		placeHits();
	};

	/** @param {ForceGraphProps} host The host's props. */
	const dressHulls = ( { selectedGroup } ) =>
		hulls
			.selectChildren( 'path' )
			.attr( 'class', ( { group } ) =>
				classes(
					`${ BLOCK }__hull`,
					group.className,
					group.id === selectedGroup && 'is-selected'
				)
			);

	return {
		view,
		dressNodes,

		/**
		 * Take the scale the view draws at.
		 *
		 * @param {number} scale The scale.
		 */
		setZoom: ( scale ) => {
			zoom = scale;
			holdZoom();
		},
		dressLinks,
		dressHulls,

		/**
		 * Draw a model: one element for each body and line, in its words and
		 * classes, wherever it last was.
		 *
		 * @param {Model}           model The model.
		 * @param {ForceGraphProps} host  The host's props.
		 */
		join: ( model, host ) => {
			// The model lists hulls deepest first; paint is outermost first.
			hulls = hulls
				.data( [ ...model.branches ].reverse(), ( { id } ) => id )
				.join( 'g' );
			keep( hulls, 'path', 'hull', all );
			keep( hulls, 'text', 'hull-label', all ).text(
				( { group } ) => group.label
			);
			dressHulls( host );

			links = links
				.data( model.links, ( { link } ) => link.id )
				.join( 'path' )
				.attr( 'stroke-width', ( { link } ) => strokeOf( link ) )
				.attr( 'opacity', ( { link } ) => opacityOf( link ) )
				.attr( 'marker-end', ( { link } ) =>
					link.directed ? `url(#${ arrowId })` : null
				);
			keep( links, 'title', 'title', titled ).text(
				( { link } ) => link.title
			);
			dressLinks( host );

			nodes = nodes
				.data( model.leaves, ( { id } ) => id )
				.join( 'g' )
				.attr( 'data-id', ( { id } ) => id );
			keep( nodes, 'rect', 'shape', unsized, ':first-child' )
				.attr( 'x', ( { halfW } ) => -halfW )
				.attr( 'y', ( { halfH } ) => -halfH )
				.attr( 'width', ( { halfW } ) => 2 * halfW )
				.attr( 'height', ( { halfH } ) => 2 * halfH )
				.attr( 'rx', 4 );
			keep( nodes, 'circle', 'shape', sized, ':first-child' ).attr(
				'r',
				( { node } ) => circleRadius( node )
			);
			keep( nodes, 'text', 'label', all )
				.attr( 'y', ( { node } ) => labelY( node ) )
				.attr( 'transform', ( { node: { scale = 1 } } ) =>
					1 === scale ? null : `scale(${ scale })`
				)
				.text( ( { node } ) => node.label );
			keep(
				nodes,
				'text',
				'detail',
				( { node } ) => node.size && node.detail
			)
				.attr( 'y', MIDDLE_DROP )
				.text( ( { node } ) => node.detail );
			keep( nodes, 'title', 'title', ( { node } ) => node.title ).text(
				( { node } ) => node.title
			);
			dressNodes( host );
		},

		/** Write every position, as the model has it. */
		place: () => {
			nodes.attr(
				'transform',
				( { x, y } ) => `translate(${ x },${ y })`
			);
			links.attr( 'd', linkPath );
			placeHits();
			outlines = [];
			hulls.each( function ( branch ) {
				const points = hullPoints( branch.leafNodes );
				outlines.push( { branch, points } );
				const hull = select( this );
				hull.select( 'path' ).attr( 'd', `M${ points.join( 'L' ) }Z` );
				hull.select( 'text' )
					.attr( 'x', polygonCentroid( points )[ 0 ] )
					.attr(
						'y',
						min( points, ( [ , y ] ) => y ) - HULL_LABEL_RISE
					);
			} );
		},

		/**
		 * The rects of the nodes, where they are painted.
		 *
		 * @return {{id: string, x: number, y: number, w: number, h: number}[]} One for each node, by its id and its corner of least x and y.
		 */
		boxes: () =>
			nodes.nodes().map( ( el ) => {
				const { id, halfW, halfH } = select( el ).datum();
				const [ x, y ] = el
					.getAttribute( 'transform' )
					.slice( 'translate('.length, -1 )
					.split( ',' );
				return {
					id,
					x: x - halfW,
					y: y - halfH,
					w: 2 * halfW,
					h: 2 * halfH,
				};
			} ),

		/**
		 * The hull painted at a point, the deepest of several.
		 *
		 * @param {[number, number]} at The point, in the graph's own units.
		 * @return {import('./model').Branch|undefined} The branch of the hull, or undefined off any.
		 */
		hullAt: ( at ) =>
			outlines
				.filter( ( { points } ) => polygonContains( points, at ) )
				.pop()?.branch,

		/** Whether no node is painted. */
		isEmpty: () => nodes.empty(),

		clear: () => root.selectChildren().remove(),
	};
};
