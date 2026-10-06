/**
 * The graph `useConsoleGraph` seeds `_metadata` with before a worker's own
 * `dump_metadata` lands, composed from a recorded `topologies get` reply and
 * `classes dump` catalog by the same calls the hook makes, in its order.
 */

import { graphFromTsl } from '../../draftToGraph';
import {
	withOwnedNodes,
	withReplAnchor,
	withResolvedConfigEdges,
} from '../../consoleGraph';
import { augmentWithVirtualEdges } from '../../virtualEdges';

/**
 * Compose a recorded seed.
 *
 * @param {Object} seed `{ tsl, expanded, resolved_config_edges, owned, classes }`.
 * @return {{nodes: Array<Object>, edges: Array<{from: string, to: string}>}} The seeded graph.
 */
export const seededGraph = ( seed ) =>
	augmentWithVirtualEdges(
		withOwnedNodes(
			withReplAnchor(
				withResolvedConfigEdges(
					graphFromTsl(
						seed.tsl,
						seed.expanded,
						seed.classes,
						seed.resolved_config_edges
					),
					seed.resolved_config_edges
				)
			),
			seed.owned
		),
		seed.classes
	);
