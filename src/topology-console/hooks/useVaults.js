/**
 * useVaults — the vault catalog behind the vault_id dropdown, as a batched-poll
 * slice.
 *
 * It used to pair `useReconcile` (its own 1s setInterval) with `useRequestNode`
 * (its own POST), so the dropdown cost a private heartbeat and a request of its
 * own — one of four such pairs the console fired in the same second. A slice
 * emits from a Timer hitchhiking the Router, inside the lock/flush bracket the
 * tick opens, so `vault list` now travels in the SAME request as every other
 * command that tick.
 *
 * Convergence comes free with the poll: there is no "loaded" event to miss, so
 * a refused session or an expired key is simply a tick that published nothing,
 * and the next one recovers.
 */

import { useNodeState } from '../../runtime/react';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import names from '../../runtime/reserved-node-names.json';
import '../nodes/register';

const FETCHER = 'vaults:fetch';
const RECEIVER = 'vaults:in';
const VIEW = 'vaults:view';

/**
 * Every router tick. A poll this frequent used to be unthinkable; batched, it
 * costs no request of its own — it rides whichever POST the tick was already
 * sending — and it is what makes recovery from a refused session immediate
 * rather than a cadence away.
 */
const POLL_INTERVAL_MS = 1000;

// Before the first reply: shaped, and loading.
const EMPTY = { vaults: null, loading: true, error: null };

/**
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] Gate — false parks the poll, so a dropdown that
 *                              is never opened costs no request.
 * @return {{vaults: Array<{id: string, url: string}>, loading: boolean, error: Error|null}}
 *   The catalog in option shape, whether the first reply is still outstanding,
 *   and the last failure. `loading` is false once a failure is in hand, since
 *   the poll keeps retrying behind it.
 */
export function useVaults( { enabled = false } = {} ) {
	useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			addSliceFetcher( interpreter, {
				fetcher: FETCHER,
				receiver: RECEIVER,
				command: 'list',
				view: VIEW,
				viewClass: 'VaultCatalogView',
				tee,
				target: `${ names.CONSOLE_TAP }/${ names.HTTP }/vault`,
			} ),
		timerName: 'vaults:timer',
		teeName: 'vaults:tee',
		enabled,
		intervalMs: POLL_INTERVAL_MS,
	} );

	const model = useNodeState( VIEW, 'view' ) ?? EMPTY;

	return {
		vaults: model.vaults ?? [],
		loading: enabled && null === model.vaults && ! model.error,
		error: model.error ?? null,
	};
}
