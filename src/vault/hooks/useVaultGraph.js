/**
 * useVaultGraph — the Vault server-credential admin graph.
 *
 * The table is the `vault list` catalog, polled as a slice like every other
 * catalog in the substrate; add / update / delete / test are one-shots. Neither
 * the list nor the answers are wired by hand here: `useCatalogSlice` owns the poll,
 * so a save owes the table no reload and a refused tick keeps what is on
 * screen, and `useCommandOnce` files each answer under the server it named,
 * because it is the only thing that sees both the send and the reply.
 *
 * There is no correlator anywhere in here, and that is the point. A command is
 * minted FROM the node that wants the answer, the server replies TO = FROM, and
 * the reply lands on that node — so a table refresh and four verbs are told
 * apart by WHICH NODE they arrive on, not by an id stamped into the message.
 */

import { useCallback } from '@wordpress/element';
import { useCatalogSlice } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';
import { views } from '../nodes/register';

const VAULT_CI = 'vault';

/**
 * Credentials change only when the operator on this tab edits them, and that
 * edit lands through its own answer — so the poll is the RETRY, not a feed. Slow
 * enough to cost nothing, often enough that a turned-over session recovers
 * without a reload.
 */
const LIST_INTERVAL_MS = 30000;

/**
 * @param {Object}   [o]
 * @param {Function} [o.onAdded] Called when an add succeeds — what closes the
 *                               modal. The one-shot fires exactly once per
 *                               reply, so nothing downstream re-derives it.
 * @return {{addServer: Function, updateServer: Function, removeServer: Function, testServer: Function, servers: ?Object[], loading: boolean, error: ?string, answerFor: (id: string) => ?Object}}
 *   The table's model, the CRUD callbacks, and the last answer PER SERVER —
 *   which is what a row renders, so no row compares a sequence number to work
 *   out whether an answer is its own.
 */
export function useVaultGraph( { onAdded } = {} ) {
	const list = useCatalogSlice( {
		scope: 'vault:list',
		ci: VAULT_CI,
		viewClass: views.VaultListView,
		key: 'servers',
		intervalMs: LIST_INTERVAL_MS,
	} );

	// A mutation shows in the table at once; the cadence is only the retry.
	const { refresh } = list;
	const add = useCommandOnce( {
		ci: VAULT_CI,
		command: 'add',
		onDone: ( { error } ) => {
			refresh();
			if ( ! error ) {
				onAdded?.();
			}
		},
	} );
	const update = useCommandOnce( {
		ci: VAULT_CI,
		command: 'update',
		onDone: refresh,
	} );
	const remove = useCommandOnce( {
		ci: VAULT_CI,
		command: 'delete',
		onDone: refresh,
	} );
	// The probe is read-only: it changes nothing the table would show.
	const test = useCommandOnce( { ci: VAULT_CI, command: 'test' } );

	const { run: runAdd } = add;
	const { run: runUpdate } = update;
	const { run: runRemove } = remove;
	const { run: runTest } = test;

	// id is positional; credentials are named args (no enabled flag).
	const addServer = useCallback(
		( fields ) =>
			runAdd(
				formatCommandArgs( [ fields.id ], {
					url: fields.url,
					auth_username: fields.auth_username,
					auth_password: fields.auth_password,
				} )
			),
		[ runAdd ]
	);

	// id is positional so a partial's id key can't retarget the row.
	const updateServer = useCallback(
		( id, partial ) => runUpdate( formatCommandArgs( [ id ], partial ) ),
		[ runUpdate ]
	);

	const removeServer = useCallback(
		( id ) => runRemove( formatCommandArgs( [ id ] ) ),
		[ runRemove ]
	);

	const testServer = useCallback(
		( id ) => runTest( formatCommandArgs( [ id ] ) ),
		[ runTest ]
	);

	// Each verb answers for itself; the first that claims the row wins.
	const answerFor = ( id ) =>
		add.answerFor( id ) ??
		update.answerFor( id ) ??
		remove.answerFor( id ) ??
		test.answerFor( id );

	return {
		...list,
		servers: list.servers ?? null,
		addServer,
		updateServer,
		removeServer,
		testServer,
		answerFor,
	};
}
