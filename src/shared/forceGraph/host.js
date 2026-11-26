/**
 * What a host builds its graph with: a circle's size by its share of the most
 * on the canvas, and the lighting a selection gives the nodes and lines.
 */

import { classes } from '../components/Modal';

/** Radius of a circle holding none, and what the most on the canvas adds. */
export const LEAST_RADIUS = 10;
const RADIUS_SPREAD = 20;

/** @typedef {import('./ForceGraph').GraphNode} GraphNode */
/** @typedef {import('./ForceGraph').GraphLink} GraphLink */

/**
 * A circle's size, by the square root of its value's share of the most, so
 * one huge value does not swamp the rest.
 *
 * A circle is drawn no narrower than its detail, so a host whose detail can be
 * wider for a smaller value names a `least` that holds the widest detail on
 * its canvas, `detailRadius()` of it, and every circle stays in the order of
 * its value. A host whose detail widens only as its value grows keeps that
 * order at `LEAST_RADIUS`, which it may leave `least` at.
 *
 * @param {number} value   Its value, at least zero.
 * @param {number} most    The largest value on the canvas, at least `value`.
 * @param {number} [least] The radius of a value of zero; `LEAST_RADIUS` without one.
 * @return {number} Its `size`; `least` while `most` is zero.
 */
export const circleSize = ( value, most, least = LEAST_RADIUS ) =>
	least + ( most > 0 ? Math.sqrt( value / most ) * RADIUS_SPREAD : 0 );

/**
 * The graph with a node's lines and what they reach lit, the rest dimmed,
 * each class added to those the host gave.
 *
 * @param {{nodes: GraphNode[], links: GraphLink[]}} graph    The graph.
 * @param {?string}                                  selected The node's id, or null to light none.
 * @return {{nodes: GraphNode[], links: GraphLink[]}} The graph it was handed, for null.
 */
export function lightGraph( graph, selected ) {
	if ( null === selected ) {
		return graph;
	}
	const touches = ( { source, target } ) =>
		selected === source || selected === target;
	const lit = new Set( [
		selected,
		...graph.links
			.filter( touches )
			.flatMap( ( { source, target } ) => [ source, target ] ),
	] );
	const shade = ( item, on ) => ( {
		...item,
		className: classes( item.className, on ? 'is-lit' : 'is-dimmed' ),
	} );
	return {
		nodes: graph.nodes.map( ( node ) => shade( node, lit.has( node.id ) ) ),
		links: graph.links.map( ( link ) => shade( link, touches( link ) ) ),
	};
}
