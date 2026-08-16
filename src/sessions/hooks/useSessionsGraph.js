/**
 * useSessionsGraph — the issued-session list.
 *
 * The table is the `sessions list` catalog, polled as a slice like every other
 * catalog in the substrate. `useCatalogSlice` owns the poll, so a revoke owes
 * the table no reload and a refused tick keeps what is on screen.
 *
 * The VERBS are not here. A row's Revoke, and the issue form's Create, are each
 * that surface's OWN one-shot, scoped to the session it is about — because one
 * node serving every row is one node doing N jobs, and the second reply would
 * land where the first did and blank the first row's status
 * ([ADR-7](../../../docs/architecture-decisions.md)).
 */

import { useCatalogSlice } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { views } from '../nodes/register';

export const SESSIONS_CI = 'sessions';

/** A row goes live → expired on the clock, so the table re-lists on its own. */
const LIST_INTERVAL_MS = 5000;

/**
 * @return {{sessions: ?Object[], scopes: string[], ttlMax: number, loading: boolean, error: ?string, refresh: Function}}
 *   The table's model and the poll's `refresh`, which a mutation calls so its
 *   effect shows at once rather than on the next cadence.
 */
export function useSessionsGraph() {
	const list = useCatalogSlice( {
		scope: 'sessions:list',
		ci: SESSIONS_CI,
		viewClass: views.SessionListView,
		key: 'sessions',
		intervalMs: LIST_INTERVAL_MS,
	} );

	return {
		...list,
		sessions: list.sessions ?? null,
		scopes: list.scopes ?? [],
		ttlMax: list.ttlMax ?? 0,
	};
}
