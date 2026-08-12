import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * `vault:list` — owns ONLY the Vault credential-LIST slice of the admin view
 * (the de-god split: the TEST-result concern is `vault:test`, a separate node).
 *
 * `fill()` receives the raw reply Messages HttpOutNode feeds back from POST
 * /command (router peels the reply's TO = `vault:list`). Everything but the
 * parse is inherited from SliceViewNode — the constructor's `emptySlice()`
 * publish, the keep-what-is-on-screen TM_ERROR banner, and the keep-the-prior
 * -slice garbage path. Only `_parse()` is overridden, because the `list` verb
 * returns a LIVE `{ vault_id:{} }` map already decoded (not a JSON string) and
 * the table wants the `Object.values` array, not the raw map.
 *
 * Nobody awaits what lands here: a `list` reply refreshes the model, and that
 * IS the result. The awaited verbs — add / update / delete / test — each mint
 * from their own `Request` node and their replies never reach this one, so a
 * failure the caller is already catching cannot also paint the table banner.
 */
export class VaultListViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty list slice — what the table renders before the first
	 * `list` reply lands: no servers yet, and loading true.
	 *
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return { servers: null, loading: true, error: null };
	}

	/**
	 * Turn the raw server map the `list` verb returned into the render model:
	 * the table wants an array, and a landed list means loading is over.
	 *
	 * @param {Object<string,Object>|null} payload The live `{ id: public_shape }`
	 *                                             map, already decoded. Null or
	 *                                             empty renders an empty table.
	 * @return {?Object} The render model, or null to keep the prior slice.
	 */
	_parse( payload ) {
		if ( payload && 'object' !== typeof payload ) {
			return null;
		}
		return {
			servers: Object.values( payload || {} ),
			loading: false,
			error: null,
		};
	}
}
