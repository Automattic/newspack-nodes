/**
 * useSessionsGraph — the issued-session list.
 *
 * The table is the `sessions list` catalog, polled as a slice like every other
 * catalog in the substrate. `useCatalogSlice` owns the poll, so a revoke owes
 * the table no reload and a refused tick keeps what is on screen.
 *
 * ONE node per verb serves every row, because the SUBJECT rides in the ADDRESS.
 * A revoke of `h-4471` is minted FROM `sessions:revoke:in/h-4471`; the server
 * echoes TO = FROM; the Router peels `sessions:revoke:in` off and the answer
 * arrives there carrying `h-4471` as its remaining TO. The breadcrumb IS the
 * correlation ([ADR-7](../../../docs/architecture-decisions.md)).
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
 * @param {Function} [o.onAnswer] `( { verb, subject, error, result } )` — once
 *                                per reply, naming the row it was about.
 * @return {{createSession: Function, revokeSession: Function, pendingVerb: (subject: string) => ?string, sessions: ?Object[], scopes: string[], ttlMax: number, loading: boolean, error: ?string}}
 *   The table's model and the two verbs; each answer reaches the caller
 *   through `onAnswer`.
 */
export function useSessionsGraph( { onAnswer } = {} ) {
	const list = useCatalogSlice( {
		scope: 'sessions:list',
		ci: SESSIONS_CI,
		viewClass: views.SessionListView,
		key: 'sessions',
		intervalMs: LIST_INTERVAL_MS,
	} );

	// A mutation shows in the table at once; the cadence is only the retry.
	const { refresh } = list;
	const answered = ( verb ) => ( answer ) => {
		onAnswer?.( { verb, ...answer } );
		refresh();
	};

	const create = useCommandOnce( {
		ci: SESSIONS_CI,
		command: 'create',
		onDone: answered( 'create' ),
	} );
	const revoke = useCommandOnce( {
		ci: SESSIONS_CI,
		command: 'revoke',
		onDone: answered( 'revoke' ),
	} );
	const { run: runCreate } = create;
	const { run: runRevoke } = revoke;

	// WHICH verb a row waits on; the outbox knows, so the screen asks.
	const pendingVerb = useCallback(
		( subject ) => {
			if ( create.isPending( subject ) ) {
				return 'create';
			}
			return revoke.isPending( subject ) ? 'revoke' : null;
		},
		[ create, revoke ]
	);

	const createSession = useCallback(
		( { label, scope, ttl } ) =>
			runCreate( formatCommandArgs( [ label ], { scope, ttl } ) ),
		[ runCreate ]
	);

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
		pendingVerb,
	};
}
