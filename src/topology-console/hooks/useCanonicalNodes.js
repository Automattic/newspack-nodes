/**
 * useCanonicalNodes — the node names a topology DECLARES, and the drift test
 * that reads them.
 *
 * A topology declares its own `make_node`s plus everything its `include`s
 * bring, since `topologies get` ships the composed graph. A live node outside
 * that set, and outside the reserved `_`-prefixed console infrastructure, was
 * added at runtime through the console or a `make_node` command: the canvas
 * paints that drift distinctly (roadmap [49]).
 *
 * The set is empty until the `.tsl` answer lands, and stays empty for a name
 * with no registered `.tsl` behind it — no topology open, or an unsaved draft.
 * Callers MUST read an empty set as "no drift information", never as
 * "everything drifted".
 */

import { useEffect, useMemo } from '@wordpress/element';
import { useTopology } from './useCatalogs';
import { graphFromTsl } from '../utils/draftToGraph';

/**
 * The live nodes a topology does not declare — the runtime drift to paint.
 *
 * A `_`-prefixed name is reserved console infrastructure the worker mounts,
 * never a line a topology file carries, so it is never drift. Null is the
 * "canonical set unknown" answer: it makes the caller skip drift coloring
 * altogether, where an empty set would flag every node on the canvas.
 *
 * @param {?Array<{id:string}>} nodes     Live graph nodes.
 * @param {?Set<string>}        canonical Canonical node names from the `.tsl`.
 * @return {?Set<string>} Drifted node ids, or null when canonical is empty.
 */
export function driftNodeIds( nodes, canonical ) {
	if ( ! canonical || canonical.size === 0 ) {
		return null;
	}
	const out = new Set();
	for ( const n of nodes || [] ) {
		if ( ! canonical.has( n.id ) && ! n.id.startsWith( '_' ) ) {
			out.add( n.id );
		}
	}
	return out;
}

/**
 * The one empty set every "canonical set unknown" render hands back, so a
 * consumer comparing by reference never re-renders on it.
 *
 * @type {Set<string>}
 */
const NO_NAMES = new Set();

/**
 * The node names `topology` declares, read from its registered `.tsl`.
 *
 * The reader publishes one answer at a time, so the answer counts only once
 * `loaded.name` matches the name asked for. Reading the previous topology's
 * answer would paint every node of the new one as drift.
 *
 * @param {string} topology Topology name, or '' for none.
 * @return {Set<string>} Canonical node names from the topology's `.tsl`.
 */
export function useCanonicalNodes( topology ) {
	const { open, topology: loaded } = useTopology( {
		scope: 'canonical',
		enabled: !! topology,
	} );

	useEffect( () => {
		open( topology );
	}, [ topology, open ] );

	return useMemo( () => {
		if ( ! topology || loaded?.name !== topology ) {
			return NO_NAMES;
		}
		// Seeded: a file's own edges may name a borrowed node.
		const parsed = graphFromTsl( loaded.tsl, loaded.expanded );
		// A borrowed node is canonical: declared, just in another file.
		const borrowed = ( loaded.expanded?.nodes || [] ).map(
			( n ) => n.name
		);
		return new Set( [ ...parsed.nodes.map( ( n ) => n.id ), ...borrowed ] );
	}, [ topology, loaded ] );
}
