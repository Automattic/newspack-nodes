/**
 * useForceRows — the rows the force canvas draws beside the graph it is handed:
 * every sidecar at any depth, and the interpreter. One `ForceRowsNode` poller
 * asks `dump_metadata -s` of `_cwd` at the canvas's own interval, which counts
 * canvas nodes alone. The scope shown rides on FROM, so a change of scope drops
 * the rows of the last one, and an answer about a scope since left does not
 * publish.
 */

import { Core } from '../../runtime/core';
import { usePoller } from './usePoller';
import { ForceRowsNode } from '../nodes/force-rows-node';

/**
 * Registered name of the poller asking for the force canvas's rows.
 *
 * @testonly Exported for the tests that answer the poller as the Router does.
 */
export const FORCE_POLLER = 'force:fetch';

/** Asks for the whole graph and every sidecar's row. */
const ARGS = [ '-s' ];

/**
 * Poll every node's row, and every sidecar's, while enabled.
 *
 * @param {boolean} enabled  False mounts nothing.
 * @param {string}  resetKey Identity of the scope shown.
 * @return {{rows: ?import('../../runtime/metadata-node').MetadataGraph, snapshot: ?import('../../runtime/metadata-node').MetadataGraph}}
 *   The rows held for this scope, and the snapshot of the last reply, which
 *   the rates sample; both null before its first answer.
 */
export function useForceRows( enabled, resetKey ) {
	const rows = usePoller( {
		name: FORCE_POLLER,
		nodeClass: ForceRowsNode,
		verb: 'dump_metadata',
		args: ARGS,
		field: 'metadata',
		subject: resetKey,
		enabled,
	} ).value;
	return { rows, snapshot: rows && Core.node( FORCE_POLLER ).snapshot };
}
