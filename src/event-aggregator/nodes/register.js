/**
 * The aggregator's two slice views, declared rather than subclassed.
 *
 * De-god split: the single AggregatorView god node (fed by one `status` verb)
 * is gone, replaced by two per-slice views — each on its own slice verb with
 * its own inspectable reply path. Both verbs answer a JSON string.
 */

import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

/** The view classes, handed to `makeNode` — a name is per-bundle. */
export const views = registerSliceViews( {
	// The header: counts computed server-side, plus the snapshot clock.
	AggregatorSummaryView: {
		json: true,
		empty: {
			connected: 0,
			idle: 0,
			total: 0,
			serverNow: null,
			error: null,
			loading: true,
			lastRefresh: null,
		},
		parse: ( body ) => ( {
			connected: body.connected || 0,
			idle: body.idle || 0,
			total: body.total || 0,
			serverNow: body.server_now ?? null,
			error: null,
			loading: false,
			lastRefresh: Date.now(),
		} ),
	},

	AggregatorServersView: {
		json: true,
		empty: { servers: null, error: null, loading: true },
		parse: ( body ) => ( {
			servers: Array.isArray( body ) ? body : [],
			error: null,
			loading: false,
		} ),
	},
} );
