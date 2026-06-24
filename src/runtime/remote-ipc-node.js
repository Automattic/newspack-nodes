/**
 * RemoteIpcNode — the per-worker interactive command channel (Remote_IPC), as
 * distinct from Remote_Source (durable aggregation, e.g. pulling `firehose.p0`).
 * One RemoteIpc per active worker, named `{topology}.p{N}`; `cd /{worker}` routes
 * commands straight to it (the worker's name IS the address — no `_sse/` prefix).
 *
 * It EXTENDS RemoteLink — composing the same SseIn + HttpOut + Heartbeat children
 * and the connected→slot bridge — and adds the two halves of the worker-pivot send
 * path that used to live in SseIn + HttpOut:
 *  - The outgoing reply-FROM wrap: a command minted by a reply node
 *    (`_output`/`_metadata`/…) gets FROM rewritten to the private pivot
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

import { Node } from './node';
import { RemoteLinkNode } from './remote-link-node';
import { newMessage, TYPE, FROM, TO, VALUE, TM_COMMAND } from './message';
import names from './reserved-node-names.json';

export class RemoteIpcNode extends RemoteLinkNode {
	// The single RemoteIpc currently holding the live SseIn (one stream per
	// browser session; a send swaps it). Static so siblings can hand it off.
	static active = null;

	constructor() {
		super();
		// Pivoted IPC, NOT a log subscription: worker reply frames carry a real
		// TO (the TO=FROM breadcrumb) the browser router must honor, so DON'T
		// re-home received frames to the target (that's RemoteLink's behavior).
		this.rehomeReceived = false;
	}

	/**
	 * Send path: a command routed in via TO={worker} (the Router peeled this
	 * node's name). Boot/steal the live connection, then route the bundled
	 * `[connect_worker_input, command]` pair through this link's own HttpOut as
	 * one POST.
	 *
	 * @param {Array} message Positional Message; TO is the remainder past {worker}.
	 */
	fill( message ) {
		this.counter += 1;
		this.connect();

		const reader = this.name;
		const remainder = message[ TO ];
		const command = message.slice();
		if ( '' !== command[ FROM ] ) {
			command[ FROM ] = `${ names.SSE }:${ this.pid() }/${
				command[ FROM ]
			}`;
		}
		command[ TO ] =
			'' === remainder ? reader : `${ reader }/${ remainder }`;

		const connect = newMessage();
		connect[ TYPE ] = TM_COMMAND;
		connect[ FROM ] = reader;
		connect[ TO ] = 'topologies';
		connect[ VALUE ] = { name: 'connect_worker_input', arguments: reader };

		// One POST: ride a pre-existing lock (the console's TIMER batch) or open
		// our own around just this pair so the mount + command share a server
		// process.
		const h = this.httpOut;
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

	// Make this link's SseIn the live stream, replacing whichever RemoteIpc held
	// it. Idempotent while already live (a steady poll stream doesn't reconnect).
	connect() {
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

	// Close the composed stream and release the live-connection claim.
	close() {
		super.close();
		if ( RemoteIpcNode.active === this ) {
			RemoteIpcNode.active = null;
		}
	}

	/**
	 * Console teardown: close THIS link's own (unnamed) stream and unregister the
	 * RemoteIpc, but leave the SHARED `_http`/`_heartbeat` for the graph to tear
	 * down. Clear the shared slot only when we were the active stream (so removing
	 * a cd'd-away link can't drop the live worker's keepalive).
	 */
	removeNode() {
		this.sseIn?.unregister( 'connected', this.name );
		this.sseIn?.close();
		if ( RemoteIpcNode.active === this ) {
			this.heartbeat?.clearSlot();
			RemoteIpcNode.active = null;
		}
		this.onClose?.();
		this.sseIn = null;
		this.httpOut = null;
		this.heartbeat = null;
		// Skip RemoteLink.removeNode (it tears down the children) — the shared
		// singletons are the graph's; Node.removeNode just unregisters this node.
		Node.prototype.removeNode.call( this );
	}

	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Per-worker interactive command channel (Remote_IPC): cd onto it and commands ride to the remote worker.',
			accepts_fill: false,
			has_target: false,
			arguments: RemoteLinkNode.nodeSchema().arguments,
			commands: [],
		};
	}
}
