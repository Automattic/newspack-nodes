/**
 * useVaultGraph — the Vault server-credential admin graph.
 *
 * The table is the `vault list` catalog, polled as a slice like every other
 * catalog in the substrate; add / update / delete / test are one-shots. Neither
 * the list nor the answers are wired by hand: `useCatalogSlice` owns the poll,
 * so a save owes the table no reload and a refused tick keeps what is on
 * screen.
 *
 * ONE node per verb serves every row, because the SUBJECT rides in
 * the ADDRESS. A test of `tw0` is minted FROM `vault:test:in/tw0`; the server
 * echoes TO = FROM; the Router peels `vault:test:in` off and the answer arrives
 * there carrying `tw0` as its remaining TO. So the reply says which row it is
 * about without an id, a table, or a node per row — the breadcrumb IS the
 * correlation ([ADR-7](../../../docs/architecture-decisions.md)).
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
 * @param {Function} [o.onAnswer] `( { verb, subject, error } )` — once per
 *                                reply, naming the row it was about.
 * @return {{addServer: Function, removeServer: Function, testServer: Function, pendingVerb: (subject: string) => ?string, servers: ?Object[], loading: boolean, error: ?string, refresh: Function}}
 *   The table's model and the verbs. Each answer reaches the caller through
 *   `onAnswer`, which is where a row learns its own outcome.
 */
export function useVaultGraph( { onAnswer } = {} ) {
	const list = useCatalogSlice( {
		scope: 'vault:list',
		ci: VAULT_CI,
		viewClass: views.VaultListView,
		key: 'servers',
		intervalMs: LIST_INTERVAL_MS,
	} );

	// A mutation shows in the table at once; the cadence is only the retry.
	const { refresh } = list;
	const answered =
		( verb ) =>
		( { subject, error } ) => {
			onAnswer?.( { verb, subject, error } );
			if ( 'test' !== verb ) {
				refresh();
			}
		};

	const add = useCommandOnce( {
		ci: VAULT_CI,
		command: 'add',
		onDone: answered( 'add' ),
	} );
	const remove = useCommandOnce( {
		ci: VAULT_CI,
		command: 'delete',
		onDone: answered( 'delete' ),
	} );
	// The probe is read-only: it changes nothing the table would show.
	const test = useCommandOnce( {
		ci: VAULT_CI,
		command: 'test',
		onDone: answered( 'test' ),
	} );
	const { run: runAdd } = add;
	const { run: runRemove } = remove;
	const { run: runTest } = test;

	// @longform WHICH verb a row is waiting on — the outbox knows, so the
	// screen asks rather than flipping a flag beside every click and clearing
	// it in every answer. The verb, not a boolean: it is what picks the row's
	// wording while the work runs.
	const pendingVerb = useCallback(
		( subject ) => {
			if ( add.isPending( subject ) ) {
				return 'add';
			}
			if ( remove.isPending( subject ) ) {
				return 'delete';
			}
			return test.isPending( subject ) ? 'test' : null;
		},
		[ add, remove, test ]
	);

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

	const removeServer = useCallback(
		( id ) => runRemove( formatCommandArgs( [ id ] ) ),
		[ runRemove ]
	);

	const testServer = useCallback(
		( id ) => runTest( formatCommandArgs( [ id ] ) ),
		[ runTest ]
	);

	return {
		...list,
		servers: list.servers ?? null,
		addServer,
		removeServer,
		testServer,
		pendingVerb,
	};
}
