/**
 * composeTargets — the destinations the message composer offers, read off the
 * graph the operator is looking at.
 *
 * Both canvases share it: the topology console passes `parsed.nodes`, the
 * debug overlay `graph.nodes`.
 */

import names from '../../runtime/reserved-node-names.json';

/**
 * Build the composer's full "To (node)" list from the VIEWED graph.
 *
 * The source is the viewed graph and never `Core.nodes`, which at a remote
 * worker cwd holds only the browser's own scaffolding (SseIn, HttpOut and the
 * rest) rather than the worker's nodes. `_command_interpreter` leads for two
 * reasons: `parseMetadata` hides the backbone, so no graph carries it, and the
 * modal preselects the first entry, which is the destination a command wants.
 * Every other node contributes its own id, plus its `<id>:config` sidecar ONLY
 * when `node.has_config` reports one registered — most nodes have none, so
 * synthesizing the sidecar for all of them offers dead targets.
 *
 * @param {Array<{id?: string, has_config?: boolean}>} nodes The graph on screen.
 * @return {string[]} Compose target ids: `_command_interpreter`, then the rest
 *                    deduplicated and sorted. A node with no id is skipped.
 */
export function buildComposeTargets( nodes ) {
	const rest = new Set();
	for ( const node of nodes || [] ) {
		const id = node?.id;
		if ( ! id || id === names.COMMAND_INTERPRETER ) {
			continue;
		}
		rest.add( id );
		if ( node.has_config ) {
			rest.add( `${ id }:config` );
		}
	}
	return [ names.COMMAND_INTERPRETER, ...Array.from( rest ).sort() ];
}
