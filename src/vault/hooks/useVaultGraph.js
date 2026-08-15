/**
 * useVaultGraph — mounts the Vault server-credential admin node graph onto the
 * canonical rule-#2 backbone (`_command_interpreter → _router`).
 *
 *   _http        (HttpOutNode — POST /command boundary)
 *   vault:listIn (Tee) → vault:list (VaultListViewNode) — the credential table
 *   vault:add | vault:update | vault:delete | vault:test  (Request) — one
 *                                                    awaited verb per node
 *
 * There is no correlator anywhere in here, and that is the point. A command is
 * minted FROM the node that wants the answer, the server replies TO = FROM, and
 * the reply lands on that node — so a table refresh and four verbs are told
 * apart by WHICH NODE they arrive on, not by an id stamped into the message.
 * The list is a publish (its reply repaints `vault:list`, nobody awaits it);
 * each mutation and the probe is a one-shot on the router tick, and the reply
 * it publishes carries the ARGUMENTS that produced it — which is how a row
 * knows the answer is about ITS server, without an id of our invention.
 *
 * Dashboards aren't REPLs: no transcript window, no tab-completion input, no
 * uptime display, no `cd` navigation. So `_output` / `_completion` / `_uptime` /
 * `_cwd` are NOT mounted here.
 *
 * The graph build is handed to `mountExospine( build )`, which snapshots Core so
 * the soft nodes can be torn down + rebuilt on `reinit()` ("Reset Graph").
 *
 * Nothing is injected: HttpOut lazily defaults its own client, and tests seam
 * at `fetch` (`installFakeCommandWire`) so the whole egress runs for real.
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

const VAULT_CI = 'vault';
const LIST_RECV = 'vault:listIn';

/** The credential-list view node the table reads its model from. */
export const LIST_VIEW = 'vault:list';

/**
 * Ask the `vault` CI to re-list, FROM the table's own receiver Tee.
 *
 * Nobody awaits this: the reply routes back to `vault:listIn`, the Tee fans it
 * to `vault:list`, and the view repaints. That IS the result.
 *
 * @param {Object} shell The `_shell` Tap every command routes through.
 */
function fireList( shell ) {
	const m = Core.node( LIST_RECV )?.command( 'list', [] ) ?? null;
	if ( null === m ) {
		return; // unauthenticated, or the receiver is gone
	}
	m[ TO ] = `${ names.HTTP }/vault`;
	shell.fill( m );
}

/**
 * @return {{ addServer: Function, updateServer: Function, removeServer: Function,
 *   testServer: Function, addResult: Object, removeResult: Object,
 *   testResult: Object }} CRUD callbacks for the thin React view, plus each
 *   mutation's last answer — every one naming the server it is about (each
 *   view's model is read via useNodeState). Reset Graph is driven by a
 *   `Core.bumpGraphGeneration()` bump — mountExospine subscribes this reused
 *   mount's rebuild to it.
 */
export function useVaultGraph() {
	// _shell Tap: the list refresh enters here, observable via connect _shell.
	const shellRef = useRef( null );

	// Bumped per (re)build; a counter (not a latch) so reinit re-renders.
	const [ , bumpBuild ] = useState( 0 );

	// One one-shot per verb; a mutation re-lists on its own answer.
	const relist = useCallback( () => {
		if ( shellRef.current ) {
			fireList( shellRef.current );
		}
	}, [] );
	const add = useCommandOnce( {
		ci: VAULT_CI,
		command: 'add',
		onDone: relist,
	} );
	const update = useCommandOnce( {
		ci: VAULT_CI,
		command: 'update',
		onDone: relist,
	} );
	const remove = useCommandOnce( {
		ci: VAULT_CI,
		command: 'delete',
		onDone: relist,
	} );
	// The probe is read-only and changes nothing, so it does not re-list.
	const test = useCommandOnce( {
		ci: VAULT_CI,
		command: 'test',
	} );

	// Mount the graph once: clip onto the exospine, then fire a list.
	useEffect( () => {
		const build = ( { interpreter, shell } ) => {
			// The table's reply edge: a receiver Tee fronts the list view.
			const listIn = interpreter.makeNode( 'Tee', LIST_RECV );
			interpreter.makeNode( 'VaultListView', LIST_VIEW );
			listIn.connectNode( LIST_VIEW );

			shellRef.current = shell;

			// Re-render so useNodeState re-subscribes to the fresh view.
			bumpBuild( ( n ) => n + 1 );

			// One immediate list via _shell, once authed (mount races /auth).
			ensureSession().then( () => {
				if ( shellRef.current === shell ) {
					fireList( shell );
				}
			} );

			// Non-node side effects undone before the nodes are removed.
			return () => {
				shellRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

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

	// test() is the probe: read-only, by server id, and no re-list.
	const testServer = useCallback(
		( id ) => runTest( formatCommandArgs( [ id ] ) ),
		[ runTest ]
	);

	return {
		addServer,
		updateServer,
		removeServer,
		testServer,
		// Each answer names its server, so a row can tell "mine".
		addResult: resultOf( add ),
		removeResult: resultOf( remove ),
		testResult: resultOf( test ),
	};
}

/**
 * The publishable half of a one-shot: what came back, and what it answered.
 *
 * @param {Object} once A `useCommandOnce` handle.
 * @return {{seq: number, subject: ?string, error: ?string, pending: boolean}}
 *   `subject` is the server id the answer is about.
 */
function resultOf( once ) {
	return {
		seq: once.seq,
		subject: once.answeredArgs?.[ 0 ] ?? null,
		error: once.error,
		pending: once.pending,
	};
}
