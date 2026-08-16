/**
 * useVaultGraph — the Vault server-credential list.
 *
 * The table is the `vault list` catalog, polled as a slice like every other
 * catalog in the substrate. `useCatalogSlice` owns the poll, so a save owes the
 * table no reload and a refused tick keeps what is on screen.
 *
 * The VERBS are not here. A row's Test and Remove, and the add form's Add, are
 * each that surface's OWN one-shot, scoped to the server it is about — because
 * one node serving every row is one node doing N jobs, and the second reply
 * would land where the first did and blank the first row's status
 * ([ADR-7](../../../docs/architecture-decisions.md)). What they share is this
 * list and its `refresh`.
 */

import { useCatalogSlice } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { views } from '../nodes/register';

export const VAULT_CI = 'vault';

/**
 * Credentials change only when the operator on this tab edits them, and that
 * edit lands through its own answer — so the poll is the RETRY, not a feed. Slow
 * enough to cost nothing, often enough that a turned-over session recovers
 * without a reload.
 */
const LIST_INTERVAL_MS = 30000;

/**
 * @return {{servers: ?Object[], loading: boolean, error: ?string, refresh: Function}}
 *   The table's model and the poll's `refresh`, which a mutation calls so its
 *   effect shows at once rather than on the next cadence.
 */
export function useVaultGraph() {
	const list = useCatalogSlice( {
		scope: 'vault:list',
		ci: VAULT_CI,
		viewClass: views.VaultListView,
		key: 'servers',
		intervalMs: LIST_INTERVAL_MS,
	} );

	return { ...list, servers: list.servers ?? null };
}
