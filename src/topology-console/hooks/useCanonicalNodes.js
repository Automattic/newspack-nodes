/**
 * useCanonicalNodes — the set of node names a topology DECLARES: its own
 * `make_node`s plus everything its `include`s bring (`topologies get` ships the
 * composed graph). Live nodes NOT in this set, and not reserved `_`-prefixed
 * console infra, are runtime DRIFT (added via the console / `make_node`) that
 * the canvas paints distinctly (roadmap [49]).
 *
 * Empty until the `.tsl` loads, and for scopes with no registered `.tsl` (the
 * in-browser `''` scope, an unsaved draft). Callers MUST treat an empty set as
 * "no drift info", never "everything drifted".
 */

import { useEffect, useMemo } from '@wordpress/element';
import { useTopology } from './useCatalogs';
import { graphFromTsl } from '../utils/draftToGraph';

/**
 * Live node ids that aren't in the canonical `.tsl` set and aren't reserved
 * `_`-prefixed console infra — the runtime DRIFT to paint distinctly (roadmap
 * [49]). Returns null when there's no canonical info (empty set) so callers skip
 * drift coloring rather than flagging every node.
 *
 * @param {Array<{id:string}>} nodes     Live graph nodes.
 * @param {Set<string>}        canonical Canonical node names from the `.tsl`.
 * @return {Set<string>|null} Drifted node ids, or null when canonical is empty.
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

// Stable, so "no canonical info" never re-renders a consumer.
const NO_NAMES = new Set();

/**
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
