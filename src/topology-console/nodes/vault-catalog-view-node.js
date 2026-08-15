import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * `vaults:view` — the vault_id dropdown's catalog, as a polled slice.
 *
 * It was a one-shot load behind a `fetched` latch set BEFORE the request, so a
 * single failure blocked the list for the life of the page. A slice has no
 * latch to get wrong: the tick is the retry, and a bad reply keeps whatever is
 * already on screen rather than blanking the dropdown.
 */
export class VaultCatalogViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty slice rendered before the first reply lands.
	 *
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return { vaults: null, loading: true, error: null };
	}

	/**
	 * Turn the live `{ id: public_shape }` map the `list` verb returns into the
	 * `{id,url}` option array the dropdown renders.
	 *
	 * @param {Object<string,Object>} payload The decoded server map.
	 * @return {?Object} The render model, or null to keep the prior slice.
	 */
	_parse( payload ) {
		if ( ! payload || 'object' !== typeof payload ) {
			return null;
		}
		return {
			vaults: Object.values( payload ).map( ( v ) => ( {
				id: v.id,
				url: v.url ?? '',
			} ) ),
			loading: false,
			error: null,
		};
	}
}
