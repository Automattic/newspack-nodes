/**
 * HullPanel — the inspector for a selected hull.
 *
 * A hull is a COMPOSITION BOUNDARY, not a node, so this panel deliberately shows
 * what the canvas cannot: the recursion we flattened out of the drawing, the
 * diamond nodes that are only visible as an overlap, and the edges crossing the
 * boundary — the borrowed subsystem's interface. The action is to OPEN it: the
 * hull is the handle for drilling into the topology it stands for.
 */

import { __, sprintf, _n } from '@wordpress/i18n';
import IncludeTree from './IncludeTree';

/**
 * Every topology reachable from `include` in the tree, in either direction.
 *
 * A nested include's nodes necessarily appear in its parent's hull — that's
 * CONTAINMENT, not sharing. Only an unrelated include that independently
 * provides the same node is a diamond worth naming.
 *
 * @param {Object} tree    Include tree (nested).
 * @param {string} include Topology to relate to.
 * @return {Set<string>} Ancestors + descendants of `include`.
 */
function relatives( tree, include ) {
	const out = new Set();
	const walk = ( node, ancestors ) => {
		for ( const [ name, sub ] of Object.entries( node || {} ) ) {
			if ( name === include ) {
				ancestors.forEach( ( a ) => out.add( a ) );
				descendants( sub ).forEach( ( d ) => out.add( d ) );
			}
			walk( sub, [ ...ancestors, name ] );
		}
	};
	walk( tree, [] );
	return out;
}

/**
 * @param {Object} node Include subtree.
 * @return {string[]} Every topology under `node`, at any depth.
 */
function descendants( node ) {
	return Object.entries( node || {} ).flatMap( ( [ name, sub ] ) => [
		name,
		...descendants( sub ),
	] );
}

/**
 * Edges with exactly one endpoint inside the hull — its interface.
 *
 * @param {Array}       edges   Graph edges.
 * @param {Set<string>} members Node ids inside the hull.
 * @return {{inbound: Array, outbound: Array}} Boundary edges by direction.
 */
function boundaryEdges( edges, members ) {
	const inbound = [];
	const outbound = [];
	for ( const e of edges || [] ) {
		const from = members.has( e.from );
		const to = members.has( e.to );
		if ( from === to ) {
			continue;
		}
		( to ? inbound : outbound ).push( e );
	}
	return { inbound, outbound };
}

export default function HullPanel( {
	include,
	hulls = [],
	parsed = { nodes: [], edges: [] },
	includeTree = {},
	onOpenTopology,
	onRemoveInclude,
} ) {
	const hull = hulls.find( ( h ) => h.include === include );
	const members = new Set( hull?.nodeIds || [] );
	const nodes = ( parsed.nodes || [] ).filter( ( n ) => members.has( n.id ) );

	/**
	 * A node an UNRELATED hull also provides — the diamond, which the canvas
	 * shows only as an overlap. An ancestor or descendant sharing the node is
	 * containment, not sharing; naming it would be noise.
	 */
	const kin = relatives( includeTree, include );
	const shared = nodes
		.map( ( n ) => ( {
			id: n.id,
			also: hulls
				.filter(
					( h ) =>
						h.include !== include &&
						! kin.has( h.include ) &&
						h.nodeIds.includes( n.id )
				)
				.map( ( h ) => h.include ),
		} ) )
		.filter( ( n ) => n.also.length > 0 );

	const { inbound, outbound } = boundaryEdges( parsed.edges, members );

	return (
		<aside className="topology-inspector topology-hull-panel">
			<h3 className="topology-insp__title">{ include }</h3>
			<div className="topology-insp__subtitle">
				{ sprintf(
					/* translators: %d: number of nodes the include provides. */
					_n( '%d node', '%d nodes', nodes.length, 'newspack-nodes' ),
					nodes.length
				) }
			</div>

			<div className="topology-hull-panel__actions">
				{ onOpenTopology && (
					<button
						type="button"
						data-testid="hull-open"
						className="topology-edit-verb__add"
						onClick={ () => onOpenTopology( include ) }
					>
						{ sprintf(
							/* translators: %s: topology name. */
							__( 'Open %s.tsl', 'newspack-nodes' ),
							include
						) }
					</button>
				) }
				{ onRemoveInclude && (
					<button
						type="button"
						data-testid="hull-remove"
						className="topology-edit-verb__remove"
						onClick={ () => onRemoveInclude( include ) }
					>
						{ __( 'Remove include', 'newspack-nodes' ) }
					</button>
				) }
			</div>

			<h4 className="topology-insp__section-title">
				{ __( 'Provides', 'newspack-nodes' ) }
			</h4>
			<ul
				className="topology-hull-panel__list"
				data-testid="hull-provides"
			>
				{ nodes.map( ( n ) => (
					<li key={ n.id }>
						<span className="topology-hull-panel__node">
							{ n.id }
						</span>
						<span className="topology-hull-panel__class">
							{ n.class }
						</span>
					</li>
				) ) }
			</ul>

			{ shared.length > 0 && (
				<>
					<h4 className="topology-insp__section-title">
						{ __( 'Shared with', 'newspack-nodes' ) }
					</h4>
					<ul
						className="topology-hull-panel__list"
						data-testid="hull-shared"
					>
						{ shared.map( ( n ) => (
							<li key={ n.id }>
								<span className="topology-hull-panel__node">
									{ n.id }
								</span>
								<span className="topology-hull-panel__also">
									{ n.also.join( ', ' ) }
								</span>
							</li>
						) ) }
					</ul>
				</>
			) }

			<h4 className="topology-insp__section-title">
				{ __( 'Interface', 'newspack-nodes' ) }
			</h4>
			<ul
				className="topology-hull-panel__list"
				data-testid="hull-interface"
			>
				{ inbound.map( ( e ) => (
					<li key={ `in-${ e.from }-${ e.to }` }>
						<span className="topology-hull-panel__dir">→</span>
						{ `${ e.from } → ${ e.to }` }
					</li>
				) ) }
				{ outbound.map( ( e ) => (
					<li key={ `out-${ e.from }-${ e.to }` }>
						<span className="topology-hull-panel__dir">←</span>
						{ `${ e.from } → ${ e.to }` }
					</li>
				) ) }
			</ul>

			<IncludeTree
				tree={
					includeTree[ include ]
						? { [ include ]: includeTree[ include ] }
						: {}
				}
				includes={ [ include ] }
				selectedOrigin={ null }
				onRemove={ null }
			/>
		</aside>
	);
}
