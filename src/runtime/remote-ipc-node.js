/**
 * RemoteIpcNode — the per-worker interactive command channel (Remote_IPC), as
 * distinct from Remote_Source (durable aggregation, e.g. pulling `firehose.p0`).
 * The console mounts one per active worker under `{topology}.p{N}`; a palette
 * node may use a different local name, while its required `reader` argument
 * remains the remote worker address. `cd /{local-name}` routes commands to it.
 *
 * It EXTENDS RemoteLink — composing the same `<name>:sse-in` child over the
 * shared `_http` + `_heartbeat` backbone, and the same connected→slot bridge —
 * and adds the two halves of the worker-attach send path:
 *  - The outgoing reply-FROM wrap: a command minted by a reply node
 *    (`_output`/`_metadata`/…) gets FROM rewritten to the private reply address
 *    `_sse:{pid}/{node}` so the server's HTTP_Filter can demux its ASYNC reply
 *    back to THIS session's stream. The `_sse` head is the server's wire
 *    contract, spelled the same in PHP, not this node's name.
 *  - The `connect_worker_input` bundling: each send rides a leading
 *    `connect_worker_input {reader}` so the stateless request-scope graph mounts
 *    the worker's input Partition before the command routes to it.
 *
 * Single live connection: a send boots this link's SseIn, closing whichever
 * RemoteIpc held it (the same swap the console does when the cwd changes worker).
 * SSE slots are a finite host-wide pool, and only the attached worker's stream is
 * read. PHP has no Remote_Ipc and steals nothing: each Remote_Source patrons its
 * own HTTP_Out, so several links connect at once.
 *
 * Both messages route through the process-wide `_http` singleton as ONE POST
 * (lock/flush), so the per-request mount and the command land in the same server
 * process. The mount serves that whole POST rather than this send, so `_http` —
 * which owns the POST — is asked whether it has already been sent.
 */

import { Core } from './core';
import { Node } from './node';
import { RemoteLinkNode } from './remote-link-node';
import { FROM, TO } from './message';
import names from './reserved-node-names.json';

/**
 * One worker's attached command channel. The console mounts it under the
 * worker's address, `cd /{local-name}` routes commands through it, and the
 * required `reader` argument names the remote worker each command rides to. See
 * the file header for the send path and the single-live-connection rule.
 */
export class RemoteIpcNode extends RemoteLinkNode {
	/**
	 * The RemoteIpc holding the live SseIn — one per session, and a send on any
	 * other RemoteIpc takes it. Null while no stream is open.
	 *
	 * @type {?RemoteIpcNode}
	 */
	static active = null;

	/**
	 * Start unconfigured — `reader` arrives with `arguments`.
	 */
	constructor() {
		super();
		this.reader = '';
		// Attached IPC, not a subscription: keep worker TO=FROM, don't re-home.
		this.rehomeReceived = false;
	}

	/**
	 * The node's argument tokens — `[ reader ]`, the remote worker address.
	 *
	 * @return {string[]} Last-set argument tokens.
	 */
	get arguments() {
		return super.arguments;
	}

	/**
	 * Clear the resolved reader before RemoteLink re-parses the tokens, so a
	 * re-assignment that omits the address leaves this node unconfigured — and
	 * loudly unusable — rather than still pointed at the previous worker.
	 *
	 * @param {string[]} value Positional argument tokens: `[ reader ]`.
	 */
	set arguments( value ) {
		this.reader = '';
		super.arguments = value;
	}

	/**
	 * Send path: a command routed in via TO={local-name} (the Router peeled this
	 * node's name). Boot/steal the live connection, then route the bundled
	 * `[connect_worker_input, command]` pair through the shared `_http` as one
	 * POST. The mount rides once per batch, not once per send — `_http` owns
	 * that claim, so it cannot outlive the batch it describes.
	 *
	 * @param {Array} message Positional Message; TO is the remainder past this node's name.
	 */
	fill( message ) {
		this.counter++;
		const reader = this.reader;
		this.connect();

		const remainder = message[ TO ];
		const command = message.slice();
		if ( '' !== command[ FROM ] ) {
			command[ FROM ] = `${ names.SSE }:${ this.pid() }/${
				command[ FROM ]
			}`;
		}
		command[ TO ] =
			'' === remainder ? reader : `${ reader }/${ remainder }`;

		// One POST: ride a pre-existing lock, else open one around this pair.
		const h = Core.node( names.HTTP );
		if ( ! h ) {
			// Mid-rebuild: no reply is deliverable, but silence reads as a 202.
			this.dropMessage( message, 'NOT_AVAILABLE' );
			return;
		}
		const pre = h.locked;
		h.lock();

		try {
			// Idempotent and serves the whole POST, so it rides once per batch.
			const mount = `mount:${ reader }`;
			if ( h.onceInBatch( mount ) ) {
				// Our own mint beside the Shell's; TO after — it isn't signed.
				const connect = this.command( 'connect_worker_input', [
					reader,
				] );
				if ( null === connect ) {
					return; // unauthenticated; re-auth is under way
				}
				connect[ TO ] = 'topologies';
				h.fill( connect );
				h.claimInBatch( mount );
			}

			h.fill( command );
		} finally {
			// Whoever opened the lock owes the flush, on every way out.
			if ( ! pre ) {
				h.flush();
			}
		}
	}

	/**
	 * Make this link's SseIn the live stream, closing whichever RemoteIpc held
	 * it. One stream per session — the console performs this same swap when the
	 * cwd moves to another worker.
	 *
	 * It drops the parent's `positions` seed and always tail-seeks: an attached
	 * command channel carries replies to commands this session is about to
	 * send, so there is no earlier position worth resuming from.
	 */
	connect() {
		this._assertConfigured();
		const current = RemoteIpcNode.active;
		if ( current === this && this.sseIn?._es ) {
			return;
		}
		if ( current && current !== this ) {
			current.close();
		}
		super.connect();
		RemoteIpcNode.active = this;
	}

	/**
	 * Refuse to touch the wire without a remote worker address. RemoteLink calls
	 * this before building children or opening the stream, so an unconfigured
	 * RemoteIpc throws on its first connect or send rather than posting commands
	 * into an empty address.
	 *
	 * @throws {Error} When no `reader` is configured.
	 */
	_assertConfigured() {
		if ( '' === this.reader ) {
			throw new Error( 'RemoteIpc requires a remote worker reader' );
		}
	}

	/**
	 * This link is addressed by its READER, and its subscription is derived
	 * from it rather than declared — so a subscription supplied later records
	 * nothing, where the parent would rewrite the worker address with it.
	 */
	_recordSubscription() {}

	/**
	 * Close the composed stream and release this session's live-connection
	 * claim, so nothing holds the slot until another link connects.
	 */
	close() {
		super.close();
		if ( RemoteIpcNode.active === this ) {
			RemoteIpcNode.active = null;
		}
	}

	/**
	 * Console teardown: tear down THIS link's own `:sse-in` and unregister the
	 * RemoteIpc, but leave the SHARED `_http`/`_heartbeat` for the graph to tear
	 * down. Clear the shared slot only when this link held the live stream, so
	 * removing a cd'd-away link cannot drop the live worker's keepalive.
	 */
	removeNode() {
		// removeNode, not close: the named child must leave the table too.
		this.sseIn?.removeNode();
		if ( RemoteIpcNode.active === this ) {
			this.heartbeat?.clearSlot( this );
			RemoteIpcNode.active = null;
		}
		this.onClose?.();
		this.sseIn = null;
		this.heartbeat = null;
		// Skip RemoteLink.removeNode (tears down children); just unregister.
		Node.prototype.removeNode.call( this );
	}

	/**
	 * Console-palette entry. Its one required argument is the remote worker
	 * address; commands arrive by TO routing rather than through a wired
	 * upstream edge, so the palette offers no fill input.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Per-worker interactive command channel (Remote_IPC): cd onto it and commands ride to the remote worker.',
			accepts_fill: false,
			has_target: true,
			arguments: [
				{
					name: 'reader',
					type: 'string',
					required: true,
					description: 'Remote worker reader, e.g. combined.p7.',
				},
			],
			commands: [],
		};
	}
}
