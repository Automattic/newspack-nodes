/**
 * The Vault tab's slice view, declared rather than subclassed.
 *
 * `VaultListView` owns the credential table and nothing else. Add, update,
 * delete and test are each minted from their own node and answered there
 * ([ADR-7](../../../docs/architecture-decisions.md)), so the `vault list` reply
 * is the only message that reaches this view.
 */

import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * The view classes. `useVaultGraph` hands `makeNode` the class itself rather
 * than its name, because the devtools hub mounts this tab against an
 * interpreter from another bundle and `includeNodes` is a per-bundle static
 * ([ADR-16](../../../docs/architecture-decisions.md)). Registering the names
 * still serves TSL and the console palette.
 */
export const views = registerSliceViews( {
	// An id-keyed struct, decoded already — no `json` flag; take the rows.
	VaultListView: {
		empty: { servers: null, loading: true, error: null },
		parse: ( body ) =>
			body && 'object' !== typeof body
				? null
				: {
						servers: Object.values( body || {} ),
						loading: false,
						error: null,
				  },
	},
} );
