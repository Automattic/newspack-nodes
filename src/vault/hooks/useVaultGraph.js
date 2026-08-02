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
 * the reply lands on that node — so a table refresh and four awaited verbs are
 * told apart by WHICH NODE they arrive on, not by an id stamped into the
 * message. The list is a publish (its reply repaints `vault:list`, nobody
 * awaits it); each mutation and the probe is a `Request` node holding exactly
 * one in-flight command, which is what leaves nothing to tell apart.
 *
 * Dashboards aren't REPLs: no transcript window, no tab-completion input, no
 * uptime display, no `cd` navigation. So `_output` / `_completion` / `_uptime` /
 * `_cwd` are NOT mounted here.
 *
 * The graph build is handed to `mountExospine( build )`, which snapshots Core so
 * the soft nodes can be torn down + rebuilt on `reinit()` ("Reset Graph").
 *
 * The command boundary is injectable: tests pass `opts.commandClient` (assigned
 * to `_http.client`) so the hook never touches the network. Production lazily
 * defaults to the shared CommandClient singleton.
 */

import { ensureSession } from '../../runtime/command-auth';
import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { CommandClient } from '../../runtime/command-client';
import { TO } from '../../runtime/message';
import { formatCommandArgs } from '../../runtime/command-args';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';
import '../nodes/register';

const HTTP = '_http';
const LIST_RECV = 'vault:listIn';
const LIST_VIEW = 'vault:list';

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
	m[ TO ] = `${ HTTP }/vault`;
	shell.fill( m );
}

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`;
 *                                      defaults to a freshly-constructed CommandClient.
 * @return {{ addServer: Function, updateServer: Function, removeServer: Function,
 *   testServer: Function }} CRUD callbacks for the thin React view (each view's
 *   model is read via useNodeState). Reset Graph is driven by a
 *   `Core.bumpGraphGeneration()` bump — mountExospine subscribes this reused
 *   mount's rebuild to it.
 */
export function useVaultGraph( opts = {} ) {
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// _shell Tap: the list refresh enters here, observable via connect _shell.
	const shellRef = useRef( null );

	// Bumped per (re)build; a counter (not a latch) so reinit re-renders.
	const [ , bumpBuild ] = useState( 0 );

	// One node per awaited verb — the whole of the correlation story.
	const add = useRequestNode( 'vault:add', 'vault' );
	const update = useRequestNode( 'vault:update', 'vault' );
	const remove = useRequestNode( 'vault:delete', 'vault' );
	const test = useRequestNode( 'vault:test', 'vault' );

	// Mount the graph once: clip onto the exospine, then fire a list.
	useEffect( () => {
		const build = ( { interpreter, shell, http } ) => {
			// Shared _http singleton (mountExospine owns it); set its client.
			http.client =
				optsRef.current.commandClient || CommandClient.fromGlobal();

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

	// A mutation's result is the caller's; the table repaints off the re-list.
	const runMutation = useCallback( async ( request, verb, args ) => {
		const result = await request( verb, args );
		if ( shellRef.current ) {
			fireList( shellRef.current );
		}
		return result;
	}, [] );

	// id is positional; credentials are named args (no enabled flag).
	const addServer = useCallback(
		( fields ) =>
			runMutation(
				add,
				'add',
				formatCommandArgs( [ fields.id ], {
					url: fields.url,
					auth_username: fields.auth_username,
					auth_password: fields.auth_password,
				} )
			),
		[ add, runMutation ]
	);

	// id is positional so a partial's id key can't retarget the row.
	const updateServer = useCallback(
		( id, partial ) =>
			runMutation(
				update,
				'update',
				formatCommandArgs( [ id ], partial )
			),
		[ update, runMutation ]
	);

	const removeServer = useCallback(
		( id ) => runMutation( remove, 'delete', formatCommandArgs( [ id ] ) ),
		[ remove, runMutation ]
	);

	// test() is the probe: read-only, by server id, and no re-list.
	const testServer = useCallback(
		( id ) => test( 'test', formatCommandArgs( [ id ] ) ),
		[ test ]
	);

	return { addServer, updateServer, removeServer, testServer };
}
