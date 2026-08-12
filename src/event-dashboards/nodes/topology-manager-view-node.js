import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * `topologymanager:view` — owns the Topology Manager list model, the single
 * surface React reads via useNodeState('topologymanager:view','view').
 *
 * A thin SliceViewNode like every other view: the base publishes the empty
 * slice so a pre-reply render is valid, folds a TM_ERROR into `error` without
 * blanking the list, and keeps the prior slice on an unparseable reply. Only
 * `_parse()` is overridden — the `topologies list` verb returns a live
 * `{ topologies, user_dir }` object, not a JSON string.
 *
 * An awaited verb (activate/deactivate) is minted from its OWN Request node and
 * its reply is addressed there, so a failure the caller is already catching
 * never reaches this node's `error` field. What lands here is the poll's, and
 * that IS the global surface.
 */
export class TopologyManagerViewNode extends SliceViewNode {
	/**
	 * The pre-reply slice: no topologies, no `user_dir`, no error, and
	 * `loading` true until the first `topologies list` reply (or a failure).
	 *
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return { topologies: [], userDir: null, error: null, loading: true };
	}

	/**
	 * Map the `list` verb's catalog onto the render model.
	 *
	 * @param {?Object} payload The reply's `{ topologies, user_dir }` object.
	 * @return {?Object} The render model, or null to keep the prior slice.
	 */
	_parse( payload ) {
		if ( ! payload || 'object' !== typeof payload ) {
			return null;
		}
		return {
			topologies: payload.topologies || [],
			userDir: payload.user_dir ?? null,
			error: null,
			loading: false,
		};
	}

	/**
	 * Hidden from the node palette: the dashboard wires this sink itself, and it
	 * takes no arguments and no target.
	 *
	 * @return {Object} The `node_schema()` descriptor the console and `help` read.
	 */
	static nodeSchema() {
		return {
			...super.nodeSchema(),
			description:
				'Topology Manager list-model sink (the React view node).',
		};
	}
}
