import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * `servers:view` — owns the de-god SERVER-CARDS slice of the Aggregator Status
 * dashboard: the per-server partition snapshot the cards render. Fed by its own
 * `servers_status` slice verb, whose reply lands here via the server's TO=FROM
 * reply — an inspectable reply path independent of the summary slice.
 *
 * The verb returns a SEQUENTIAL ARRAY of server snapshots; this view wraps it as
 * `{ servers }` and clears loading/error for the server-cards block. Neither
 * failure blanks the grid: the base SliceViewNode keeps the servers already on
 * screen for a TM_ERROR, and `_parse` returns null for anything unparseable.
 */
export class AggregatorServersViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty model rendered before the first reply: `servers`
	 * null because nothing has been fetched, and `loading` set, which is the
	 * flag the widget gates its server list and empty state on.
	 *
	 * @return {{servers: ?Array, error: ?string, loading: boolean}} Empty slice.
	 */
	emptySlice() {
		return { servers: null, error: null, loading: true };
	}

	/**
	 * Wrap the verb's sequential array of server snapshots into the render
	 * model, clearing error and loading.
	 *
	 * @param {*} payload The reply's VALUE.payload — the verb's JSON string.
	 * @return {?{servers: Array, error: ?string, loading: boolean}} The render
	 *   model; null when the payload is unparseable, which the base class reads
	 *   as "keep the prior slice".
	 */
	_parse( payload ) {
		const servers = super._parse( payload );
		if ( null === servers ) {
			return null;
		}
		return {
			servers: Array.isArray( servers ) ? servers : [],
			error: null,
			loading: false,
		};
	}
}
