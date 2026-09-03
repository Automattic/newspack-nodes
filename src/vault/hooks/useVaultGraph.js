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

/** The server CI mount the list poll and all four verbs are addressed to. */
const VAULT_CI = 'vault';

/**
 * The list poll's cadence. Credentials change only when the operator on this
 * tab edits them, and that edit lands through its own answer — so the poll is
 * the RETRY, not a feed. Slow enough to cost nothing, often enough that a
 * turned-over session recovers without a reload.
 */
const LIST_INTERVAL_MS = 30000;

/**
 * One verb's outcome for one row, as `onAnswer` receives it.
 *
 * @typedef {Object} VaultAnswer
 * @property {string}  verb    The verb answered: add, update, delete or test.
 * @property {?string} subject The server id the send was about, read off the
 *                             reply's own address.
 * @property {?string} error   The refusal, or null when the verb succeeded.
 */

/**
 * What the screen runs to file one row's outcome.
 *
 * @typedef {(answer: VaultAnswer) => void} OnVaultAnswer
 */

/**
 * The fields the add and the edit form both collect.
 *
 * @typedef {Object} VaultServerFields
 * @property {string} id            The id the entry is to carry.
 * @property {string} url           The spoke's HTTPS base URL.
 * @property {string} auth_username HTTP Basic user, or '' for none.
 * @property {string} auth_password HTTP Basic password; blank on an edit keeps
 *                                  the stored one.
 */

/**
 * Mount the vault catalog and its four verbs, and hand back the table's model
 * with the calls that change it.
 *
 * @param {Object}        [o]          Options.
 * @param {OnVaultAnswer} [o.onAnswer] Runs once per reply, naming the row it
 *                                     was about. This is where a row learns
 *                                     its own outcome; the model carries none.
 * @return {{addServer: (fields: VaultServerFields) => void, updateServer: (id: string, fields: VaultServerFields) => void, removeServer: (id: string) => void, testServer: (id: string) => void, pendingVerb: (subject: ?string) => ('add'|'update'|'delete'|'test'|null), servers: ?Object[], loading: boolean, error: ?string, refresh: () => void}}
 *   The catalog model — `servers` stays null until the first reply lands —
 *   plus the four verbs and `pendingVerb()`.
 */
export function useVaultGraph( { onAnswer } = {} ) {
	const list = useCatalogSlice( {
		scope: 'vault:list',
		ci: VAULT_CI,
		// The CLASS, not the name: `includeNodes` is per-bundle (ADR-16).
		viewClass: views.VaultListView,
		key: 'servers',
		intervalMs: LIST_INTERVAL_MS,
	} );

	const { refresh } = list;

	/**
	 * Build one verb's `onDone`: hand the answer to the caller under the verb
	 * that earned it, then re-`list()` after a write. A mutation shows in the
	 * table at once; the cadence is only the retry.
	 *
	 * @param {'add'|'update'|'delete'|'test'} verb The verb being answered for.
	 * @return {(answer: {subject: ?string, error: ?string}) => void} The
	 *   handler `useCommandOnce` runs once per reply to that verb.
	 */
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
	const update = useCommandOnce( {
		ci: VAULT_CI,
		command: 'update',
		onDone: answered( 'update' ),
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
	const { run: runUpdate } = update;
	const { run: runRemove } = remove;
	const { run: runTest } = test;

	/**
	 * WHICH verb a row is waiting on, or null. The outbox knows, so the screen
	 * asks rather than flipping a flag beside every click and clearing it in
	 * every answer. The verb, not a boolean: it is what picks the row's wording
	 * while the work runs.
	 */
	const pendingVerb = useCallback(
		( subject ) => {
			if ( add.isPending( subject ) ) {
				return 'add';
			}
			if ( update.isPending( subject ) ) {
				return 'update';
			}
			if ( remove.isPending( subject ) ) {
				return 'delete';
			}
			return test.isPending( subject ) ? 'test' : null;
		},
		[ add, update, remove, test ]
	);

	/**
	 * Send `add`. The id is positional; the credentials are named args. There
	 * is no enabled flag to send — a spoke is enabled by being in the vault.
	 */
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

	/**
	 * Send `update`, addressed by the id the entry HAS; the one it moves TO
	 * rides as `--new_id`. The URL and the username always ride; the password
	 * is the one field an edit may leave out.
	 */
	const updateServer = useCallback(
		( id, fields ) => {
			const options = {};
			if ( fields.id !== id ) {
				options.new_id = fields.id;
			}
			options.url = fields.url;
			options.auth_username = fields.auth_username;
			// Blank keeps the stored one; `--auth_password=` would CLEAR it.
			if ( fields.auth_password ) {
				options.auth_password = fields.auth_password;
			}
			return runUpdate( formatCommandArgs( [ id ], options ) );
		},
		[ runUpdate ]
	);

	/** Send `delete`; the server refuses an entry the config file pins. */
	const removeServer = useCallback(
		( id ) => runRemove( formatCommandArgs( [ id ] ) ),
		[ runRemove ]
	);

	/** Send `test`: probe the spoke and report whether it answers. */
	const testServer = useCallback(
		( id ) => runTest( formatCommandArgs( [ id ] ) ),
		[ runTest ]
	);

	return {
		...list,
		// Before the view node exists, the model is bare, not the empty slice.
		servers: list.servers ?? null,
		addServer,
		updateServer,
		removeServer,
		testServer,
		pendingVerb,
	};
}
