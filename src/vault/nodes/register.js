/**
 * The vault dashboard's slice view, declared rather than subclassed.
 */

import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

/** The view classes, handed to `makeNode` — a name is per-bundle. */
export const views = registerSliceViews( {
	// `vault list` answers a live `{ id: public_shape }` map; take the rows.
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
