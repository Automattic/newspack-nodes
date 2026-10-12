/**
 * useSidecarRow — the live row of one owned node, which the canvas never
 * draws, for the Inspector to show in its owner's place: a `Metadata` poller
 * asking `dump_metadata <name>` of `_cwd`, the name riding on FROM so only an
 * answer about it publishes. It refreshes at the live cadence the canvas
 * keeps for any graph under two hundred nodes.
 */

import { usePoller } from './usePoller';

/** Registered name of the poller asking for the shown sidecar's row. */
export const SIDECAR_POLLER = 'sidecar:fetch';

/**
 * Poll one node's `dump_metadata` row while `name` is set.
 *
 * @param {?string} name The owned node to show, or null for none.
 * @return {?{nodes: Array, edges: Array}} The parsed one-node graph, null
 *   while no name is set and before the first answer about this one.
 */
export function useSidecarRow( name ) {
	return usePoller( {
		name: SIDECAR_POLLER,
		nodeClass: 'Metadata',
		verb: 'dump_metadata',
		args: name ? [ name ] : [],
		field: 'metadata',
		subject: name,
		enabled: !! name,
	} ).value;
}
