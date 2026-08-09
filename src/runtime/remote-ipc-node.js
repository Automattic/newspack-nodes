/**
 * RemoteIpcNode — the per-worker interactive command channel (Remote_IPC), as
 * distinct from Remote_Source (durable aggregation, e.g. pulling `firehose.p0`).
 * The console mounts one per active worker under `{topology}.p{N}`; a palette
 * node may use a different local name, while its required `reader` argument
 * remains the remote worker address. `cd /{local-name}` routes commands to it.
 *
 * It EXTENDS RemoteLink — composing the same SseIn + HttpOut + Heartbeat children
 * and the connected→slot bridge — and adds the two halves of the worker-attach send
 * path:
 *  - The outgoing reply-FROM wrap: a command minted by a reply node
 *    (`_output`/`_metadata`/…) gets FROM rewritten to the private reply address
 *    `_sse:{pid}/{node}` so the server's HTTP_Filter can demux its ASYNC reply
 *    back to THIS session's stream. The `_sse` head is the server's wire
 *    contract (unchanged on the PHP side), not this node's name.
 *  - The `connect_worker_input` bundling: each send rides a leading
 *    `connect_worker_input {reader}` so the stateless request-scope graph mounts
 *    the worker's input Partition before the command routes to it.
 *
 * Single live connection: a send boots this link's SseIn, closing whichever
 * RemoteIpc held it (the same swap the console does when the cwd changes worker).
 * The PHP side will hold several at once — same composition, different start
 * policy. Both messages route through this link's OWN HttpOut as ONE POST
 * (lock/flush), so the per-request mount and the command land in the same server
 * process.
 */

import { Core } from './core';
import { Node } from './node';
import { RemoteLinkNode } from './remote-link-node';
import { FROM, TO } from './message';
import names from './reserved-node-names.json';

/**
 * One worker's attached command channel. The console mounts it under the
 * worker's address and `cd /{local-name}` routes commands through it; the
 * required `reader` argument names the remote worker they ride to. See the file
 * header above for the send path and the single-live-connection rule.
 */
export class RemoteIpcNode extends RemoteLinkNode {
	// The RemoteIpc holding the live SseIn (one/session; a send swaps it).
	static active = null;

	/**
	 * Start unconfigured — `reader` arrives with `arguments`. An attached IPC is
	 * not a subscription, so received messages keep the worker's TO=FROM
	 * addressing instead of being re-homed to this node's target.
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
	 * `[connect_worker_input, command]` pair through this link's own HttpOut as
	 * one POST.
	 *
	 * @param {Array} message Positional Message; TO is the remainder past {worker}.
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

		// Our own mint beside the Shell's; TO after, since it isn't signed.
		const connect = this.command( 'connect_worker_input', [ reader ] );
		if ( null === connect ) {
			return; // unauthenticated; re-auth is under way
		}
		connect[ TO ] = 'topologies';

		// One POST: ride a pre-existing lock, else open one around this pair.
		const h = Core.node( names.HTTP );
		const pre = h.locked;
		if ( ! pre ) {
			h.lock();
		}
		h.fill( connect );
		h.fill( command );
		if ( ! pre ) {
			h.flush();
		}
	}

	/**
	 * Make this link's SseIn the live stream, closing whichever RemoteIpc held
	 * it. One stream per session — the console performs this same swap when the
	 * cwd moves to another worker.
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
	 * this before building children or opening the stream, which is why an
	 * unconfigured RemoteIpc fails at configuration time instead of sending
	 * commands into an empty address.
	 *
	 * @throws {Error} When no `reader` is configured.
	 */
	_assertConfigured() {
		if ( '' === this.reader ) {
			throw new Error( 'RemoteIpc requires a remote worker reader' );
		}
	}

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
	 * down. Clear the shared slot only when we were the active stream (so removing
	 * a cd'd-away link can't drop the live worker's keepalive).
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
