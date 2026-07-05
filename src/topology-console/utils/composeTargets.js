import names from '../../runtime/reserved-node-names.json';

/**
 * Build the message-composer's full "To (node)" target list from the VIEWED
 * graph (`parsed.nodes`) — never from `Core.nodes`, which at a remote worker
 * cwd holds only the browser's own scaffolding (SseIn/HttpOut/…), not the
 * worker's graph. `_command_interpreter` always leads (it's the interpreter
 * TM_COMMAND targets by default); every other node contributes its own id, plus
 * its `:config` sidecar ONLY when the node actually has one (`node.has_config`,
 * reported by dump_metadata) — not every node does, so synthesizing `<id>:config`
 * for all of them listed dead targets. Sorted.
 *
 * @param {Array} nodes `parsed.nodes` — the graph currently on screen.
 * @return {string[]} Compose target ids, `_command_interpreter` first.
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
