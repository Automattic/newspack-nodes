import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * A catalog whose reply IS a list — `taillog sources` for the Log Viewer's
 * picker and segment sidebar, `list_logs` for the Partition Viewer's dropdown.
 *
 * Both used to be fetched once inside the graph build with the failure
 * swallowed, so a refusal at mount left the picker empty and the dashboard with
 * no way back but a reload. Polled, a refusal is one tick that published
 * nothing, and a rotation shows up without anyone asking.
 */
export class CatalogListViewNode extends SliceViewNode {
	/**
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return { items: [], error: null };
	}

	/**
	 * Keep the last good catalog unless the reply carries a list — a partial
	 * body would empty the picker for a tick.
	 *
	 * @param {*} payload The decoded catalog body.
	 * @return {?Object} The render model, or null to keep the prior slice.
	 */
	_parse( payload ) {
		if ( ! Array.isArray( payload ) ) {
			return null;
		}
		return { items: payload, error: null };
	}
}
