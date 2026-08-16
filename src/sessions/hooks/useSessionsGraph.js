/**
 * useSessionsGraph — the issued-session admin graph.
 *
 * The table is the `sessions list` catalog, polled as a slice like every other
 * catalog in the substrate; `create` and `revoke` are one-shots. Neither the
 * list nor the answers are wired by hand here: `useCatalogSlice` owns the poll, and
 * `useCommandOnce` files each answer under the subject it named, because it is
 * the only thing that sees both the send and the reply.
 *
 * There is no correlator. A command is minted FROM the node that wants the
 * answer, the server replies TO = FROM, and the reply lands on that node — so
 * the table refresh and the two verbs are told apart by WHICH NODE they arrive
 * on, never by an id stamped into the message.
 */

import { useCallback } from '@wordpress/element';
import { useCatalogSlice } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';
import { views } from '../nodes/register';

const SESSIONS_CI = 'sessions';

/** A row goes live → expired on the clock, so the table re-lists on its own. */
const LIST_INTERVAL_MS = 5000;

/**
 * @param {Object}   [o]
 * @param {Function} [o.onIssued] Called with the issued session when a create
 *                                succeeds — the key is disclosed once, so it is
 *                                handed over rather than published.
 * @return {{createSession: Function, revokeSession: Function, sessions: ?Object[], scopes: string[], ttlMax: number, loading: boolean, error: ?string, answerFor: (subject: string) => ?Object}}
 *   The table's model, plus the two verbs and the last answer PER SUBJECT (a
 *   handle, or the label a create submitted) — which is what a row renders.
 */
export function useSessionsGraph( { onIssued } = {} ) {
	const list = useCatalogSlice( {
		scope: 'sessions:list',
		ci: SESSIONS_CI,
		viewClass: views.SessionListView,
		key: 'sessions',
		intervalMs: LIST_INTERVAL_MS,
	} );

	// A mutation shows in the table at once; the cadence is only the retry.
	const { refresh } = list;
	const create = useCommandOnce( {
		ci: SESSIONS_CI,
		command: 'create',
		onDone: ( { error, result } ) => {
			refresh();
			if ( ! error ) {
				onIssued?.( result );
			}
		},
	} );
	const revoke = useCommandOnce( {
		ci: SESSIONS_CI,
		command: 'revoke',
		onDone: refresh,
	} );

	// Each verb answers for itself; the first that claims the row wins.
	const answerFor = ( subject ) =>
		create.answerFor( subject ) ?? revoke.answerFor( subject );

	const { run: runCreate } = create;
	const createSession = useCallback(
		( { label, scope, ttl } ) =>
			runCreate( formatCommandArgs( [ label ], { scope, ttl } ) ),
		[ runCreate ]
	);

	const { run: runRevoke } = revoke;
	const revokeSession = useCallback(
		( handle ) => runRevoke( formatCommandArgs( [ handle ] ) ),
		[ runRevoke ]
	);

	return {
		...list,
		sessions: list.sessions ?? null,
		scopes: list.scopes ?? [],
		ttlMax: list.ttlMax ?? 0,
		createSession,
		revokeSession,
		answerFor,
	};
}
