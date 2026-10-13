/**
 * useSidecarRows — the live rows of the owned nodes the console shows, which
 * the canvas never draws: a sidecar in the Inspector and an owner's grid of
 * sidecar cards. One `SidecarRowsNode` poller asks `dump_metadata -o` of
 * `_cwd` for each owner and the sidecars it lists, the owners riding on FROM
 * so only an answer about them publishes, and its first ask leaves on the
 * mount. It refreshes as the canvas does: every two seconds up to 200 rows,
 * slower past them. A change of owners re-asks the same poller at once,
 * which keeps every row it holds for a name still covered until the new
 * answer lands.
 */

import { Core } from '../../runtime/core';
import { useNodeField } from '../../runtime/react';
import { usePoller } from './usePoller';
import { OWNED_FLAG, SidecarRowsNode } from '../nodes/sidecar-rows-node';

/** Registered name of the poller asking for the shown sidecars' rows. */
export const SIDECAR_POLLER = 'sidecar:fetch';

/**
 * Poll the rows of `owners` and of the sidecars each lists, while any is set.
 *
 * @param {string[]} owners The nodes whose rows and sidecars to show; none mounts nothing.
 * @return {{graph: ?import('../../runtime/metadata-node').MetadataGraph, snapshot: ?import('../../runtime/metadata-node').MetadataGraph, answered: string[]}}
 *   The rows held for the owners asked, which an optimistic edit may patch;
 *   the snapshot of the last reply, which the rates sample; both null before
 *   any answer. And the names an answer covered, a row or none.
 */
export function useSidecarRows( owners ) {
	const graph = usePoller( {
		name: SIDECAR_POLLER,
		nodeClass: SidecarRowsNode,
		verb: 'dump_metadata',
		args: [ OWNED_FLAG, ...owners ],
		field: 'metadata',
		subject: owners.join( ' ' ),
		enabled: owners.length > 0,
		retarget: true,
	} ).value;
	useNodeField( SIDECAR_POLLER, 'snapshot' );
	const poller = graph ? Core.node( SIDECAR_POLLER ) : null;
	return {
		graph,
		snapshot: poller?.snapshot ?? null,
		answered: poller?.answered ?? [],
	};
}
