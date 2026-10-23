/**
 * The Sessions tab's slice view, declared rather than subclassed.
 *
 * `SessionListView` owns the whole tab. One `sessions list` reply carries the
 * issued sessions, the OAuth connections, the TTL ceiling and the scope ladder
 * together, so both tables, the TTL bound and the scope picker read one slice. The bound and the
 * ladder come from the server because a second copy of them in JavaScript
 * drifts into offering a scope the mint refuses.
 */

import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * The view classes. `useSessionsGraph` hands `makeNode` the class itself rather
 * than its name, because the station mounts this tab against an interpreter from
 * another bundle and `includeNodes` is a per-bundle static
 * ([ADR-16](../../../docs/architecture-decisions.md)). Registering the names
 * still serves TSL and the console palette.
 */
export const views = registerSliceViews( {
	SessionListView: {
		empty: {
			sessions: null,
			connections: null,
			scopes: [],
			ttlMax: 0,
			loading: true,
			error: null,
		},
		// Guard the two fields the tables map; a shape miss keeps the rows.
		parse: ( body ) =>
			body &&
			'object' === typeof body &&
			Array.isArray( body.sessions ) &&
			Array.isArray( body.connections )
				? {
						sessions: body.sessions,
						connections: body.connections,
						scopes: Array.isArray( body.scopes ) ? body.scopes : [],
						ttlMax: Number( body.ttl_max ) || 0,
						loading: false,
						error: null,
				  }
				: null,
	},
} );
