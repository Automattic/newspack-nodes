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
 * interpreter. The router peels `_http`, HttpOutNode POSTs, the server pivots the
 * reply TO=FROM, the router peels the receiver Tee, the Tee fans to its view, and
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

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { CommandClient } from '../../runtime/command-client';
import {
	newMessage,
	TYPE,
	TO,
	FROM,
	ID,
	VALUE,
	TM_COMMAND,
} from '../../runtime/message';
import { formatCommandArgs } from '../../runtime/command-args';
import '../nodes/register';

const HTTP = '_http';
const LIST_RECV = 'vault:listIn';
const LIST_VIEW = 'vault:list';
const TEST_RECV = 'vault:testIn';
const TEST_VIEW = 'vault:test';

// Monotonic per-hook-instance ID counter for LIST-concern ops — message[ID] is
// what the list view uses to match a reply back to a pending Promise resolver.
// (The test concern correlates by server id instead, so a probe's result files
// under the row it belongs to.)
let nextOpId = 0;
function makeOpId() {
	nextOpId += 1;
	return `vault-op-${ Date.now() }-${ nextOpId }`;
}

/**
 * Build a TM_COMMAND addressed at the `vault` CI. FROM = the concern's receiver
 * Tee so the server's reply pivot lands on that concern; TO=`_http/vault` so the
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
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = from;
	m[ TO ] = `${ HTTP }/vault`;
	m[ ID ] = id;
	m[ VALUE ] = { name: verb, arguments: args };
	return m;
}

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`;
 *                                      defaults to a freshly-constructed CommandClient.
 * @return {{ addServer: Function, updateServer: Function, removeServer: Function,
 *   testServer: Function }} CRUD callbacks for the thin React view (each view's
 *   model is read via useNodeState). Reset Graph is driven by the overlay via
 *   `Core.reinit`, stashed by mountExospine.
 */
export function useVaultGraph( opts = {} ) {
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Live interpreter handle for the CRUD callbacks.
	const interpreterRef = useRef( null );
	// The backbone `_shell` command Tap — CRUD dispatches enter HERE (not straight
	// at the interpreter) so every Vault command is observable via `connect _shell`.
	const shellRef = useRef( null );

	// Bumped on every (re)build so a consumer's useNodeState re-subscribes to the
	// freshly-registered view nodes. A monotonic counter, not a boolean latch —
	// reinit()'s second build must still force a render.
	const [ , bumpBuild ] = useState( 0 );

	// Mount the graph once: clip it onto the exospine, then fire one immediate list.
	useEffect( () => {
		const build = ( { interpreter, shell } ) => {
			const data =
				( typeof window !== 'undefined' && window.NewspackNodesData ) ||
				{};

			// I/O boundary node — HttpOutNode is the only one this CRUD-on-demand
			// dashboard needs.
			const http = interpreter.makeNode( 'HttpOut', HTTP );
			http.client =
				optsRef.current.commandClient ||
				new CommandClient( {
					baseUrl: data.restUrl || '/wp-json/',
					nonce: data.nonce || '',
				} );

			// Per-concern reply edges: a receiver Tee in front of each view so the
			// debug overlay shows traffic per concern, and a slice's reply never
			// touches its sibling. The LIST concern (list/add/update/delete) feeds
			// vault:list; the probe concern (test) feeds vault:test.
			const listIn = interpreter.makeNode( 'Tee', LIST_RECV );
			interpreter.makeNode( 'VaultListView', LIST_VIEW );
			listIn.connectNode( LIST_VIEW );

			const testIn = interpreter.makeNode( 'Tee', TEST_RECV );
			interpreter.makeNode( 'VaultTestView', TEST_VIEW );
			testIn.connectNode( TEST_VIEW );

			interpreterRef.current = interpreter;
			shellRef.current = shell;

			// Re-render so useNodeState re-subscribes to the freshly-mounted views.
			bumpBuild( ( n ) => n + 1 );

			// Fire one immediate list through `_shell` → interpreter (so the command
			// is observable at `_shell`). Fire-and-forget: the list view updates
			// render state on the reply.
			shell.fill( buildCommand( LIST_RECV, 'list', '', makeOpId() ) );

			// Non-node side effects undone before the nodes are removed.
			return () => {
				interpreterRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Dispatch a verb on a concern (FROM its receiver Tee) and return a Promise
	// the concern's view settles by matching `message[ID]` against its `replies`
	// map. `id` defaults to a monotonic op-id; the test concern passes the server
	// id so the probe result files under the right row.
	const dispatch = useCallback(
		( recv, view, verb, args = '', id = null ) => {
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
			// Enter at `_shell` (forwards to the interpreter) so the command is
			// observable via `connect _shell`.
			shell.fill( buildCommand( recv, verb, args, opId ) );
			return promise;
		},
		[]
	);

	// Run a registry-mutating verb on the LIST concern, then re-list to refresh
	// the table. A failure rejects to the caller; the list view leaves its banner
	// clean for a pending-matched error (no extra control fill needed).
	const runMutation = useCallback(
		async ( verb, args ) => {
			const result = await dispatch( LIST_RECV, LIST_VIEW, verb, args );
			// Fire-and-forget re-list (replaces window.location.reload()).
			dispatch( LIST_RECV, LIST_VIEW, 'list', '' ).catch( () => {} );
			return result;
		},
		[ dispatch ]
	);

	// id is the positional token; the credentials are named args. A spoke is
	// "enabled" by being wired into the graph — there is no enabled flag.
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

	// id is positional (so a `partial` carrying its own `id` key can't retarget
	// the row); only the changed fields ride as named args.
	const updateServer = useCallback(
		( id, partial ) =>
			runMutation( 'update', formatCommandArgs( [ id ], partial ) ),
		[ runMutation ]
	);

	const removeServer = useCallback(
		( id ) => runMutation( 'delete', formatCommandArgs( [ id ] ) ),
		[ runMutation ]
	);

	// test() is the probe concern — read-only, FROM the test receiver, correlated
	// by server id so vault:test files the result under the right row. Returns the
	// probe result to the caller for per-row status; no re-list.
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
