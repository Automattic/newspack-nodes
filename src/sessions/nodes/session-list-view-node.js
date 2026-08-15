import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * `sessions:list` — owns the issued-session table slice: the rows, the scope
 * vocabulary the create form offers, and the TTL ceiling it bounds its input
 * by. All three come off ONE `list` reply, because they change together.
 *
 * Nobody awaits what lands here: a `list` reply repaints the table, and that IS
 * the result. `create` and `revoke` each mint from their own `Request` node, so
 * a failure the caller is already catching never also paints this banner.
 */
export class SessionListViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty slice — what the table renders before the first
	 * reply lands.
	 *
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return {
			sessions: null,
			scopes: [],
			ttlMax: 0,
			loading: true,
			error: null,
		};
	}

	/**
	 * Flatten the `list` struct into the render model.
	 *
	 * @param {Object} payload The decoded `{ sessions, ttl_max, scopes }` struct.
	 * @return {?Object} The render model, or null to keep the prior slice.
	 */
	_parse( payload ) {
		if (
			! payload ||
			'object' !== typeof payload ||
			! Array.isArray( payload.sessions )
		) {
			return null;
		}
		return {
			sessions: payload.sessions,
			scopes: Array.isArray( payload.scopes ) ? payload.scopes : [],
			ttlMax: Number( payload.ttl_max ) || 0,
			loading: false,
			error: null,
		};
	}
}
