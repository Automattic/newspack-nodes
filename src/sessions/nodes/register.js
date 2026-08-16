/**
 * The sessions dashboard's slice view, declared rather than subclassed.
 */

import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

/** The view classes, handed to `makeNode` — a name is per-bundle. */
export const views = registerSliceViews( {
	SessionListView: {
		empty: {
			sessions: null,
			scopes: [],
			ttlMax: 0,
			loading: true,
			error: null,
		},
		parse: ( body ) =>
			body && 'object' === typeof body && Array.isArray( body.sessions )
				? {
						sessions: body.sessions,
						scopes: Array.isArray( body.scopes ) ? body.scopes : [],
						ttlMax: Number( body.ttl_max ) || 0,
						loading: false,
						error: null,
				  }
				: null,
	},
} );
