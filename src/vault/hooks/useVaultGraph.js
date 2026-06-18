/**
 * useVaultGraph — mounts the Vault server-credential admin node graph onto the
 * canonical rule-#2 backbone (`_command_interpreter → _router`) using the
 * substrate's HTTP I/O boundary node — the minimal mount surface a
 * CRUD-on-demand dashboard needs:
 *
 *   _http       (HttpOutNode — POST /command boundary; .client = CommandClient)
 *
 * Plus the application's render-model node:
 *
 *   vault:view  (the view-model node React reads + the hook's pending-Promise registry)
 *
 * Dashboards aren't REPLs: no transcript window, no tab-completion input, no
 * uptime display, no `cd` navigation. So `_output` / `_completion` / `_uptime` /
 * `_cwd` are NOT mounted here — they'd be dead weight and would collide with
 * the debug-overlay's REPL when it opens on this page.
 *
 * The graph build is handed to `mountExospine( build )`, which snapshots Core so
 * the soft nodes can be torn down + rebuilt on `reinit()` ("Reset Graph"). The
 * hook owns the CRUD dispatch — on each call it builds a TM_COMMAND
 * (FROM=`vault:view`, TO=`_http/vault`, verb in VALUE.name) with a unique
 * `message[ID]`, stashes a `{ resolve, reject }` resolver in `vault:view`'s
 * `replies` map under that ID, and fills the message into the interpreter. The router
 * peels `_http`, HttpOutNode POSTs, the server pivots the reply TO=FROM, the router
 * peels `vault:view`, and the view's `fill()` matches `message[ID]` against
 * `replies`, resolving or rejecting the Promise (and updating the render model
 * for `list` replies + surfacing TM_ERROR into the view's `error`).
 *
 * Mutations (add/update/delete) re-list on success to refresh the table.
 * test() is read-only and does NOT re-list. Mutation rejections also surface
 * into the view model (via the view's TM_ERROR path) so the table shows them,
 * AND re-throw to the caller.
 *
 * The command boundary is injectable: tests pass `opts.commandClient` (assigned
 * to `_http.client`) so the hook never touches the network. Production lazily
 * defaults to the shared CommandClient singleton.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { CommandClient } from '../../runtime/command_client';
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
const VIEW = 'vault:view';

// Monotonic per-hook-instance ID counter — message[ID] is what the view uses
// to match a reply back to a pending Promise resolver.
let nextOpId = 0;
function makeOpId() {
	nextOpId += 1;
	return `vault-op-${ Date.now() }-${ nextOpId }`;
}

/**
 * Build a TM_COMMAND addressed at the `vault` CI: FROM=`vault:view` so the
 * server's reply pivot lands on the view; TO=`_http/vault` so the router peels
 * `_http` and HttpOutNode POSTs the bare command. `id` is the correlator the view
 * uses to resolve the hook's Promise.
 *
 * @param {string} verb Verb name (list / add / update / delete / test).
 * @param {string} args Tachikoma-style argument string (built via formatCommandArgs).
 * @param {string} id   Correlator stamped into message[ID].
 * @return {Array} A 7-field positional Message.
 */
function buildCommand( verb, args, id ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = VIEW;
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
 *   testServer: Function }} CRUD callbacks for the thin React view (the model is
 *   read via useNodeState). Reset Graph is driven by the overlay via `Core.reinit`,
 *   stashed by mountExospine.
 */
export function useVaultGraph( opts = {} ) {
	const optsRef = useRef( opts );
	optsRef.current = opts;

	// Live interpreter handle for the CRUD callbacks.
	const interpreterRef = useRef( null );

	// Bumped on every (re)build so a consumer's useNodeState re-subscribes to the
	// freshly-registered view node. A monotonic counter, not a boolean latch —
	// reinit()'s second build must still force a render.
	const [ , bumpBuild ] = useState( 0 );

	// Mount the graph once: clip it onto the exospine, then fire one immediate list.
	useEffect( () => {
		// The soft view-nodes the backbone clips onto. mountExospine snapshots
		// Core around this so reinit() removes exactly these and rebuilds them.
		const build = ( { interpreter } ) => {
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

			// The application view-model node — receiver of every reply via TO=FROM pivot.
			interpreter.makeNode( 'VaultView', VIEW );

			interpreterRef.current = interpreter;

			// Re-render so useNodeState re-subscribes to the freshly-mounted view node.
			bumpBuild( ( n ) => n + 1 );

			// Fire one immediate list (the canonical "everything sinks into the interpreter"
			// path — interpreter forwards to router → router peels `_http` → HttpOutNode POSTs).
			// Fire-and-forget: the view updates render state on the reply.
			interpreter.fill( buildCommand( 'list', '', makeOpId() ) );

			// Non-node side effects undone before the nodes are removed.
			return () => {
				interpreterRef.current = null;
			};
		};

		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Dispatch a verb (with a pre-built args string) and return a Promise that
	// resolves with the unwrapped payload (or rejects with a TM_ERROR). The view
	// matches `message[ID]` against its `replies` map to settle the Promise.
	const dispatch = useCallback( ( verb, args = '' ) => {
		const interpreter = interpreterRef.current;
		if ( ! interpreter ) {
			return Promise.reject( new Error( 'graph not mounted' ) );
		}
		const view = Core.node( VIEW );
		if ( ! view ) {
			return Promise.reject( new Error( 'view not mounted' ) );
		}
		const id = makeOpId();
		const promise = new Promise( ( resolve, reject ) => {
			view.replies.add( id, resolve, reject );
		} );
		interpreter.fill( buildCommand( verb, args, id ) );
		return promise;
	}, [] );

	// Run a registry-mutating verb, then re-list to refresh the table. A failure
	// rejects to the caller; the view already surfaced the error into its model
	// via the TM_ERROR reply path (no extra control fill needed).
	const runMutation = useCallback(
		async ( verb, args ) => {
			const result = await dispatch( verb, args );
			// Fire-and-forget re-list (replaces window.location.reload()).
			dispatch( 'list', '' ).catch( () => {} );
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

	// test() is read-only — return its probe result to the caller for per-row
	// status; no re-list (a probe doesn't change the registry).
	const testServer = useCallback(
		( id ) => dispatch( 'test', formatCommandArgs( [ id ] ) ),
		[ dispatch ]
	);

	return { addServer, updateServer, removeServer, testServer };
}
