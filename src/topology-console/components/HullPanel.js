/**
 * HullPanel — the inspector for a selected hull, and, in `whole` mode, for the
 * topology being edited.
 *
 * A hull is a COMPOSITION BOUNDARY, not a node, so this panel deliberately shows
 * what the canvas cannot: the recursion we flattened out of the drawing, the
 * diamond nodes that are only visible as an overlap, and the edges crossing the
 * boundary — the borrowed subsystem's interface. It is the handle for drilling
 * into the topology it stands for, and for removing the include that brings it.
 */

import { __, sprintf, _n } from '@wordpress/i18n';
import IncludeTree from './IncludeTree';
import { NodeLinks } from './InspectorFields';
import {
	ProcessStatsView,
	activityFromSeries,
	formatActivityWindow,
} from './ProcessStats';
import { processStats } from '../utils/processStats';
import { hullNodes } from '../utils/hullNodes';

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
 * The subtree an include brings in, wherever the tree nests it. A shared
 * include is one file, so every place it appears carries the same subtree.
 *
 * @param {Object} tree Nested include tree, `{ name: subtree }`.
 * @param {string} name The include to find.
 * @return {?Object} Its subtree, or null when the tree does not hold it.
 */
function subtreeOf( tree, name ) {
	for ( const [ key, sub ] of Object.entries( tree || {} ) ) {
		const found = key === name ? sub || {} : subtreeOf( sub, name );
		if ( found ) {
			return found;
		}
	}
	return null;
}

/**
 * Flattens an include subtree into the names it contains.
 *
 * Containment runs the full depth, so `relatives` needs every level: a
 * grandchild's nodes belong to the hull as much as a child's do.
 *
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
 * An edge with both endpoints inside is the include's private wiring, and one
 * with neither belongs to another scope; only a crossing edge says how the
 * borrowed subsystem is used. The DESTINATION names the direction: an edge
 * landing on a member is inbound, one leaving a member outbound.
 *
 * @param {Array}       edges   Graph edges, each `{ from, to }` node ids.
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

/**
 * The hull's own traffic, rolled up the same way the process header rolls up a
 * whole graph: `in` is what the member SOURCES produced, `out` what the member
 * SINKS consumed — so a message hopping between two members isn't counted twice.
 *
 * An include made only of pass-through nodes has neither a source nor a sink,
 * so its message totals read 0/0 while its byte totals still sum: that traffic
 * is interior to some other scope's boundary. The window label takes the WHOLE
 * graph's node count, because the metadata poll interval scales with the graph
 * rather than with the hull.
 *
 * @param {Object} props
 * @param {Array}  props.nodes      The hull's member nodes.
 * @param {number} props.graphSize  Node count of the whole graph.
 * @param {Object} props.rateSeries `{ in, out, read, write }` sample rings.
 * @return {import('react').ReactElement} Activity + Throughput for the hull.
 */
function HullStats( { nodes, graphSize, rateSeries } ) {
	const { messagesIn, messagesOut, bytesRead, bytesWritten } =
		processStats( nodes );
	return (
		<ProcessStatsView
			testId="hull-stats"
			windowMeta={ formatActivityWindow( graphSize ) }
			activity={ activityFromSeries( rateSeries ) }
			totals={ {
				msgsIn: messagesIn,
				msgsOut: messagesOut,
				bytesRead,
				bytesWritten,
			} }
		/>
	);
}

/**
 * The panel for a selected hull: what its include provides, which of those nodes
 * an unrelated include also provides, and the edges crossing the boundary. In
 * `whole` mode the same sections describe the edited file itself.
 *
 * @param {Object}                  props
 * @param {string}                  props.include           Topology the hull stands for; titles the panel.
 * @param {Array}                   [props.hulls]           Every hull, `{ include, nodeIds }[]` — scopes this one's members and finds the diamonds.
 * @param {Object}                  [props.parsed]          The WHOLE graph, `{ nodes, edges }`; the hull's members are a subset of it.
 * @param {Object}                  [props.rateSeries]      `{ in, out, read, write }` sample rings, already scoped to the hull; edit mode shows no stats and reads none.
 * @param {boolean}                 [props.editMode]        Draft graph: counters don't exist yet, so stats hide and the remove button appears.
 * @param {Object}                  [props.includeTree]     Nested include tree from `topologies expand`; tells containment apart from sharing.
 * @param {string[]}                [props.includes]        Directly-declared includes — only one of those has a line to remove.
 * @param {Function}                [props.onOpenTopology]  (name) — drill into the hull's own topology.
 * @param {Function}                [props.onRemoveHull]    (name) — remove the include that brings the hull.
 * @param {(name: string) => void}  [props.onSelectHull]    Selects a child include's hull by its name.
 * @param {(name: string) => void}  [props.onSelectNode]    Selects a node by its name in any list.
 * @param {boolean}                 [props.whole]           `include` names the edited topology itself: every node is a member, Shared is a node two declared includes both provide, and Interface is the wiring between its own nodes and its includes.
 * @param {(name: string) => void}  [props.onRemoveInclude] With `whole`, removes a declared include from its row.
 * @param {(name: ?string) => void} [props.onHoverNode]     Lights a named node on the canvas, null on leave.
 * @param {Set<string>}             [props.nodeIds]         Ids in the graph; a name outside it is not a link.
 * @return {import('react').ReactElement} The hull inspector.
 */
export default function HullPanel( {
	include,
	whole = false,
	onSelectNode,
	onHoverNode,
	nodeIds,
	onRemoveInclude,
	hulls = [],
	parsed = { nodes: [], edges: [] },
	rateSeries,
	editMode = false,
	includeTree = {},
	includes = [],
	onOpenTopology,
	onRemoveHull,
	onSelectHull,
} ) {
	const nodes = whole
		? parsed.nodes || []
		: hullNodes( parsed.nodes, hulls, include );
	const members = new Set( nodes.map( ( n ) => n.id ) );

	/**
	 * A node an UNRELATED hull also provides — the diamond, which the canvas
	 * shows only as an overlap. An ancestor or descendant sharing the node is
	 * containment, not sharing; naming it would be noise.
	 */
	const kin = relatives( includeTree, include );
	// @longform Whole: a declared include, unless another declared include
	// already contains it (containment, as below). Hull: any unrelated include.
	const nested = new Set(
		includes.filter( ( d ) =>
			includes.some(
				( o ) =>
					o !== d &&
					descendants( subtreeOf( includeTree, o ) ).includes( d )
			)
		)
	);
	const counts = ( h ) =>
		whole
			? includes.includes( h.include ) && ! nested.has( h.include )
			: h.include !== include && ! kin.has( h.include );
	const shared = nodes
		.map( ( n ) => ( {
			id: n.id,
			also: hulls
				.filter( ( h ) => counts( h ) && h.nodeIds.includes( n.id ) )
				.map( ( h ) => h.include ),
		} ) )
		.filter( ( n ) => n.also.length > ( whole ? 1 : 0 ) );

	// A whole file's boundary runs between its own nodes and its includes'.
	const known =
		nodeIds ?? new Set( ( parsed.nodes || [] ).map( ( n ) => n.id ) );
	const hulled = new Set( hulls.flatMap( ( h ) => h.nodeIds ) );
	const own = whole
		? new Set(
				nodes
					.map( ( n ) => n.id )
					.filter( ( id ) => ! hulled.has( id ) )
		  )
		: members;
	const wiring = whole
		? ( parsed.edges || [] ).filter(
				( e ) => known.has( e.from ) && known.has( e.to )
		  )
		: parsed.edges;
	const { inbound, outbound } = boundaryEdges( wiring, own );
	const crossings = inbound.length + outbound.length;

	// What THIS topology includes — its own name would just restate the title.
	const subtree = whole
		? includeTree
		: subtreeOf( includeTree, include ) || {};
	const children = whole
		? includes.filter( ( n ) =>
				Object.prototype.hasOwnProperty.call( includeTree, n )
		  )
		: Object.keys( subtree );
	const title = include || __( 'Untitled topology', 'newspack-nodes' );
	const link = ( id ) => (
		<NodeLinks
			names={ [ id ] }
			nodeIds={ known }
			onSelect={ onSelectNode }
			onHover={ onHoverNode }
		/>
	);

	return (
		<aside className="topology-inspector topology-hull-panel">
			<h3 className="topology-insp__title">{ title }</h3>
			<div className="topology-insp__subtitle">
				{ sprintf(
					/* translators: %d: number of nodes the include provides. */
					_n( '%d node', '%d nodes', nodes.length, 'newspack-nodes' ),
					nodes.length
				) }
			</div>

			<div className="topology-hull-panel__actions">
				{ ! whole && onOpenTopology && (
					<button
						type="button"
						data-testid="hull-open"
						className="button button-small topology-hull-panel__open"
						onClick={ () => onOpenTopology( include ) }
					>
						{ sprintf(
							/* translators: %s: topology name. */
							__( 'Open %s.tsl', 'newspack-nodes' ),
							include
						) }
					</button>
				) }

				{ /* Only a DIRECTLY-declared include has a line to remove. */ }
				{ ! whole &&
					editMode &&
					onRemoveHull &&
					includes.includes( include ) && (
						<button
							type="button"
							data-testid="hull-remove"
							className="button button-small button-link-delete topology-hull-panel__remove"
							onClick={ () => onRemoveHull( include ) }
						>
							{ __( 'Remove include', 'newspack-nodes' ) }
						</button>
					) }
			</div>

			{ /* A draft graph has no counters, so edit mode hides stats. */ }
			{ ! editMode && (
				<HullStats
					nodes={ nodes }
					graphSize={ ( parsed.nodes || [] ).length }
					rateSeries={ rateSeries }
				/>
			) }

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
							{ link( n.id ) }
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
						{ __( 'Shared', 'newspack-nodes' ) }
					</h4>
					<ul
						className="topology-hull-panel__list"
						data-testid="hull-shared"
					>
						{ shared.map( ( n ) => (
							<li key={ n.id }>
								<span className="topology-hull-panel__node">
									{ link( n.id ) }
								</span>
								<span className="topology-hull-panel__also">
									{ n.also.join( ', ' ) }
								</span>
							</li>
						) ) }
					</ul>
				</>
			) }

			{ ( ! whole || crossings > 0 ) && (
				<>
					<h4 className="topology-insp__section-title">
						{ __( 'Interface', 'newspack-nodes' ) }
					</h4>
					<ul
						className="topology-hull-panel__list"
						data-testid="hull-interface"
					>
						{ [
							...inbound.map( ( e ) => [ '→', e ] ),
							...outbound.map( ( e ) => [ '←', e ] ),
						].map( ( [ dir, e ] ) => (
							<li key={ `${ dir }-${ e.from }-${ e.to }` }>
								<span className="topology-hull-panel__dir">
									{ dir }
								</span>
								{ link( e.from ) }
								{ ' → ' }
								{ link( e.to ) }
							</li>
						) ) }
					</ul>
				</>
			) }

			{ children.length > 0 && (
				<div data-testid="hull-includes">
					<IncludeTree
						tree={ subtree }
						includes={ children }
						onRemove={ whole ? onRemoveInclude : null }
						onSelect={ onSelectHull }
					/>
				</div>
			) }
		</aside>
	);
}
