/**
 * The Aggregator Status dashboard's two slice views, declared rather than
 * subclassed.
 *
 * Each owns one verb of the hub-side `aggregator` interpreter and publishes it
 * on its own `view` state for a React widget: `summary` feeds the header strip,
 * `list_servers` feeds the server cards. Two views rather than one give each
 * slice its own reply path, so a card list that fails leaves the header counts
 * on screen. Each parse takes the verb's struct and refuses any other shape,
 * keeping the slice already on screen.
 */

import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * The view classes. `useAggregatorStatusGraph` hands `makeNode` the class
 * itself rather than the name, because the station mounts this tab against
 * an interpreter from another bundle and `includeNodes` is a per-bundle static
 * ([ADR-16](../../../docs/architecture-decisions.md)). Registering the names
 * still serves TSL and the console palette.
 */
export const views = registerSliceViews( {
	// Counts come from the server, so the header needs no card payload.
	AggregatorSummaryView: {
		empty: {
			connected: 0,
			idle: 0,
			total: 0,
			serverNow: null,
			unreadable: {},
			error: null,
			loading: true,
			lastRefresh: null,
		},
		parse: ( body ) =>
			body && 'object' === typeof body
				? {
						connected: body.connected || 0,
						idle: body.idle || 0,
						total: body.total || 0,
						// Seconds, and the clock the cards' "ago" strings use.
						serverNow: body.server_now ?? null,
						// Each active topology that will not read, name => why.
						unreadable: body.unreadable ?? {},
						error: null,
						loading: false,
						// Browser ms: when the reply landed, not the snapshot.
						lastRefresh: Date.now(),
				  }
				: null,
	},

	// The cards: the snapshot the summary counts, as a sequential array.
	AggregatorServersView: {
		empty: { servers: null, error: null, loading: true },
		parse: ( body ) =>
			Array.isArray( body )
				? { servers: body, error: null, loading: false }
				: null,
	},
} );
