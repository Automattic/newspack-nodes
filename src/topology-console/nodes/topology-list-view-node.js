import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * `topologies:list:view` — the OPEN dialog's saved-topology catalog, as a slice.
 *
 * A refused fetch used to leave the dialog permanently empty, and a save owed
 * the catalog an explicit `reload()`. The poll owes it nothing: the next tick
 * carries the new entry, and a refusal is one tick that published nothing.
 */
export class TopologyListViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty catalog rendered before the first reply lands.
	 *
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return { topologies: null, userDir: '', error: null };
	}

	/**
	 * Keep the prior catalog unless the body carries the list — a partial body
	 * would blank the dialog for one tick.
	 *
	 * @param {Object} payload The decoded `topologies list` body.
	 * @return {?Object} The render model, or null to keep the prior slice.
	 */
	_parse( payload ) {
		if ( ! Array.isArray( payload?.topologies ) ) {
			return null;
		}
		return {
			topologies: payload.topologies,
			userDir: payload.user_dir || '',
			error: null,
		};
	}
}
