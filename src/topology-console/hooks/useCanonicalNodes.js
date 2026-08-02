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

import { useState, useEffect } from '@wordpress/element';
import { useTopology } from './useTopologyList';
import { parseTsl } from '../utils/parseTsl';

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

/**
 * @param {string} topology Topology name, or '' for none.
 * @return {Set<string>} Canonical node names from the topology's `.tsl`.
 */
export function useCanonicalNodes( topology ) {
	const fetchTopology = useTopology( { enabled: !! topology } );
	const [ names, setNames ] = useState( () => new Set() );

	useEffect( () => {
		if ( ! topology ) {
			setNames( new Set() );
			return undefined;
		}
		let live = true;
		fetchTopology( topology )
			.then( ( resp ) => {
				if ( ! live ) {
					return;
				}
				const parsed = parseTsl( resp?.tsl || '' );
				// A borrowed node is canonical: declared, just in another file.
				const borrowed = ( resp?.expanded?.nodes || [] ).map(
					( n ) => n.name
				);
				setNames(
					new Set( [
						...parsed.nodes.map( ( n ) => n.id ),
						...borrowed,
					] )
				);
			} )
			.catch( () => {
				// Best-effort: no canonical set means no drift coloring.
				if ( live ) {
					setNames( new Set() );
				}
			} );
		return () => {
			live = false;
		};
	}, [ topology, fetchTopology ] );

	return names;
}
