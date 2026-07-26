/**
 * useVaultGraph — mounts the Vault server-credential admin node graph onto the
 * canonical rule-#2 backbone (`_command_interpreter → _router`) using the
 * substrate's HTTP I/O boundary node. The de-god decomposition: instead of ONE
 * `vault:view` god view holding the whole model, the graph wires TWO focused
 * per-concern views, each behind its OWN receiver Tee — so the debug overlay
 * shows reply traffic PER CONCERN rather than one opaque node:
 *
 *   _http        (HttpOutNode — POST /command boundary; .client = CommandClient)
 *   vault:listIn (Tee) → vault:list (VaultListViewNode) — list/add/update/delete
 *   vault:testIn (Tee) → vault:test (VaultTestViewNode) — connection-probe results
 *
 * Dashboards aren't REPLs: no transcript window, no tab-completion input, no
 * uptime display, no `cd` navigation. So `_output` / `_completion` / `_uptime` /
 * `_cwd` are NOT mounted here.
 *
 * The graph build is handed to `mountExospine( build )`, which snapshots Core so
 * the soft nodes can be torn down + rebuilt on `reinit()` ("Reset Graph"). The
 * hook owns the CRUD dispatch — on each call it builds a TM_COMMAND
 * (FROM = the concern's receiver Tee, TO = `_http/vault`, verb in VALUE.name)
 * with a correlator in `message[ID]`, stashes a `{ resolve, reject }` resolver in
 * the matching view's `replies` map under that ID, and fills the message into the
 * interpreter. The router peels `_http`, HttpOutNode POSTs, the server replies
 * TO=FROM, the router peels the receiver Tee, the Tee fans to its view, and
 * the view settles the Promise (and updates its own render model).
 *
 * list / add / update / delete are the LIST concern (FROM=vault:listIn). test is
 * the probe concern (FROM=vault:testIn, correlated by server id). Mutations
 * (add/update/delete) re-list to refresh the table. test() is read-only and does
 * NOT re-list. Each concern's failures reject to the caller; the list view never
 * paints a banner for a pending-matched error, and the test view records each
 * probe per-row.
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
import { TO, ID } from '../../runtime/message';
import { formatCommandArgs } from '../../runtime/command-args';
import '../nodes/register';

const HTTP = '_http';
const LIST_RECV = 'vault:listIn';
const LIST_VIEW = 'vault:list';
const TEST_RECV = 'vault:testIn';
const TEST_VIEW = 'vault:test';

// Monotonic op-id for LIST ops; the list view matches replies by message[ID].
let nextOpId = 0;
function makeOpId() {
	nextOpId += 1;
	return `vault-op-${ Date.now() }-${ nextOpId }`;
}

/**
 * Build a TM_COMMAND addressed at the `vault` CI. FROM = the concern's receiver
 * Tee so the server's reply path lands on that concern; TO=`_http/vault` so the
 * router peels `_http` and HttpOutNode POSTs the bare command. `id` is the
 * correlator the receiving view uses to settle the hook's Promise.
 *
 * @param {string} from Receiver Tee name (vault:listIn / vault:testIn).
 * @param {string} verb Verb name (list / add / update / delete / test).
 * @param {string} args Tachikoma-style argument string (built via formatCommandArgs).
 * @param {string} id   Correlator stamped into message[ID].
 * @return {Array} A 7-field positional Message.
 */
function buildCommand( from, verb, args, id ) {
	// The receiver Tee mints; TO/ID after (neither is signed).
	const m = Core.node( from )?.command( verb, args ) ?? null;
	if ( null === m ) {
		return null; // unauthenticated, or the receiver is gone
	}
	m[ TO ] = `${ HTTP }/vault`;
	m[ ID ] = id;
	return m;
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

	// Live interpreter handle for the CRUD callbacks.
	const interpreterRef = useRef( null );
	// _shell Tap: CRUD enters here, observable via connect _shell.
	const shellRef = useRef( null );

	// Bumped per (re)build; a counter (not a latch) so reinit re-renders.
	const [ , bumpBuild ] = useState( 0 );

	// Mount the graph once: clip onto the exospine, then fire a list.
	useEffect( () => {
		const build = ( { interpreter, shell, http } ) => {
			// Shared _http singleton (mountExospine owns it); set its client.
			http.client =
				optsRef.current.commandClient || CommandClient.fromGlobal();

			// Per-concern reply edges: a receiver Tee fronts each view.
			const listIn = interpreter.makeNode( 'Tee', LIST_RECV );
			interpreter.makeNode( 'VaultListView', LIST_VIEW );
			listIn.connectNode( LIST_VIEW );

			const testIn = interpreter.makeNode( 'Tee', TEST_RECV );
			interpreter.makeNode( 'VaultTestView', TEST_VIEW );
			testIn.connectNode( TEST_VIEW );

			interpreterRef.current = interpreter;
			shellRef.current = shell;

			// Re-render so useNodeState re-subscribes to the fresh views.
			bumpBuild( ( n ) => n + 1 );

			// One immediate list via _shell, once authed (mount races /auth).
			ensureSession().then( () => {
				const m = buildCommand( LIST_RECV, 'list', [], makeOpId() );
				if ( null !== m && shellRef.current === shell ) {
					shell.fill( m );
				}
			} );

			// Non-node side effects undone before the nodes are removed.
			return () => {
				interpreterRef.current = null;
				shellRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Dispatch a verb FROM a concern's Tee; its view settles by message[ID].
	const dispatch = useCallback(
		( recv, view, verb, args = [], id = null ) => {
			const shell = shellRef.current;
			if ( ! shell ) {
				return Promise.reject( new Error( 'graph not mounted' ) );
			}
			const node = Core.node( view );
			if ( ! node ) {
				return Promise.reject( new Error( 'view not mounted' ) );
			}
			const opId = id || makeOpId();
			const promise = new Promise( ( resolve, reject ) => {
				node.replies.add( opId, resolve, reject );
			} );
			// Enter at _shell so the command is observable there.
			const m = buildCommand( recv, verb, args, opId );
			if ( null === m ) {
				return Promise.reject( new Error( 'not authenticated' ) );
			}
			shell.fill( m );
			return promise;
		},
		[]
	);

	// Run a mutating verb on the LIST concern, then re-list the table.
	const runMutation = useCallback(
		async ( verb, args ) => {
			const result = await dispatch( LIST_RECV, LIST_VIEW, verb, args );
			// Fire-and-forget re-list (replaces window.location.reload()).
			dispatch( LIST_RECV, LIST_VIEW, 'list', [] ).catch( () => {} );
			return result;
		},
		[ dispatch ]
	);

	// id is positional; credentials are named args (no enabled flag).
	const addServer = useCallback(
		( fields ) =>
			runMutation(
				'add',
				formatCommandArgs( [ fields.id ], {
					url: fields.url,
					auth_username: fields.auth_username,
					auth_password: fields.auth_password,
				} )
			),
		[ runMutation ]
	);

	// id is positional so a partial's id key can't retarget the row.
	const updateServer = useCallback(
		( id, partial ) =>
			runMutation( 'update', formatCommandArgs( [ id ], partial ) ),
		[ runMutation ]
	);

	const removeServer = useCallback(
		( id ) => runMutation( 'delete', formatCommandArgs( [ id ] ) ),
		[ runMutation ]
	);

	// test() is the probe concern: read-only, by server id, no re-list.
	const testServer = useCallback(
		( id ) =>
			dispatch(
				TEST_RECV,
				TEST_VIEW,
				'test',
				formatCommandArgs( [ id ] ),
				id
			),
		[ dispatch ]
	);

	return { addServer, updateServer, removeServer, testServer };
}
