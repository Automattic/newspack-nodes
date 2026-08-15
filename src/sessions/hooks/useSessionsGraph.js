/**
 * useSessionsGraph — mounts the issued-session admin graph onto the canonical
 * rule-#2 backbone (`_command_interpreter → _router`), in the same shape as
 * `useVaultGraph`:
 *
 *   sessions:listIn (Tee) → sessions:list (SessionListViewNode) — the table
 *   sessions:create | sessions:revoke (Request) — one awaited verb per node
 *
 * There is no correlator. A command is minted FROM the node that wants the
 * answer, the server replies TO = FROM, and the reply lands on that node — so
 * the table refresh and the two awaited verbs are told apart by WHICH NODE
 * they arrive on, never by an id stamped into the message.
 */

import { ensureSession } from '../../runtime/command-auth';
import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { TO } from '../../runtime/message';
import { formatCommandArgs } from '../../runtime/command-args';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import names from '../../runtime/reserved-node-names.json';
import '../nodes/register';

const SESSIONS_CI = 'sessions';
const LIST_RECV = 'sessions:listIn';

/** The view node the table reads its model from. */
export const LIST_VIEW = 'sessions:list';

/**
 * Ask the `sessions` CI to re-list, FROM the table's own receiver Tee. Nobody
 * awaits it: the reply routes back to `sessions:listIn`, the Tee fans it to
 * `sessions:list`, and the view repaints. That IS the result.
 *
 * @param {Object} shell The `_shell` Tap every command routes through.
 */
function fireList( shell ) {
	const m = Core.node( LIST_RECV )?.command( 'list', [] ) ?? null;
	if ( null === m ) {
		return; // unauthenticated, or the receiver is gone
	}
	m[ TO ] = `${ names.HTTP }/sessions`;
	shell.fill( m );
}

/**
 * @return {{createSession: Function, revokeSession: Function, createResult: Object, revokeResult: Object}}
 *   Callbacks for the thin React view, plus each verb's last answer — the
 *   arguments that produced it included, so a row knows which reply is its own.
 *   The table's model is read via useNodeState.
 */
export function useSessionsGraph() {
	const shellRef = useRef( null );
	const [ , bumpBuild ] = useState( 0 );

	// A mutation re-lists on its answer; the server's state, not a patch.
	const relist = useCallback( () => {
		if ( shellRef.current ) {
			fireList( shellRef.current );
		}
	}, [] );
	const create = useCommandOnce( {
		ci: SESSIONS_CI,
		command: 'create',
		onDone: relist,
	} );
	const revoke = useCommandOnce( {
		ci: SESSIONS_CI,
		command: 'revoke',
		onDone: relist,
	} );

	useEffect( () => {
		const build = ( { interpreter, shell } ) => {
			const listIn = interpreter.makeNode( 'Tee', LIST_RECV );
			interpreter.makeNode( 'SessionListView', LIST_VIEW );
			listIn.connectNode( LIST_VIEW );

			shellRef.current = shell;
			bumpBuild( ( n ) => n + 1 );

			// One immediate list via _shell, once authed (mount races /auth).
			ensureSession().then( () => {
				if ( shellRef.current === shell ) {
					fireList( shell );
				}
			} );

			return () => {
				shellRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

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
		createSession,
		revokeSession,
		createResult: answerOf( create ),
		revokeResult: answerOf( revoke ),
	};
}

/**
 * The publishable half of a one-shot: what came back, and what it answered.
 *
 * @param {Object} once A `useCommandOnce` handle.
 * @return {{seq: number, subject: ?string, result: ?Object, error: ?string}}
 *   `subject` is the label or handle the answer is about.
 */
function answerOf( once ) {
	return {
		seq: once.seq,
		subject: once.answeredArgs?.[ 0 ] ?? null,
		result: once.result,
		error: once.error,
	};
}
