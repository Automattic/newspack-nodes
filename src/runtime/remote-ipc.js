/**
 * RemoteIpcNode — the per-worker interactive command channel (Remote_IPC), as
 * distinct from Remote_Source (durable aggregation, e.g. pulling `firehose.p0`).
 * One RemoteIpc per active worker, named `{topology}.p{N}`; `cd /{worker}` routes
 * commands straight to it (the worker's name IS the address — no `_sse/` prefix).
 *
 * Mirroring the PHP Remote_Source_Node, it is a PATRON, not a connector subclass:
 * it COMPOSES an SseIn (the same receive primitive the dashboards use) for the
 * inbound stream and routes its sends through the shared `_http` HttpOut. It
 * absorbs the two halves of the old worker-pivot send path:
 *  - SseIn's outgoing reply-FROM wrap — a command minted by a reply node
 *    (`_output`/`_metadata`/…) gets FROM rewritten to the private pivot
 *    `_sse:{pid}/{node}` so the server's HTTP_Filter can demux its ASYNC reply
 *    back to THIS session's stream. The `_sse` head is the server's wire
 *    contract (unchanged on the PHP side), not this node's name.
 *  - HttpOut's `connect_worker_input` bundling — each send rides a leading
 *    `connect_worker_input {reader}` so the stateless request-scope graph mounts
 *    the worker's input Partition before the command routes to it.
 *
 * Single live connection: a send boots this patron's SseIn, closing whichever
 * RemoteIpc held it (the same swap the console does when the cwd changes worker).
 * The PHP side will hold several at once — same composition, different start
 * policy. Both messages route through `_http` as ONE POST (lock/flush), so the
 * per-request mount and the command land in the same server process.
 */

import { Node } from './node';
import { SseInNode } from './sse-in-node';
import { Core } from './core';
import { newMessage, TYPE, FROM, TO, VALUE, TM_COMMAND } from './message';
import names from './reserved-node-names.json';
import { REPLY_NODES } from './reply-nodes';

export class RemoteIpcNode extends Node {
	// The single RemoteIpc currently holding the live SseIn (one stream per
	// browser session; a send swaps it). Static so siblings can hand it off.
	static active = null;

	constructor() {
		super();
		// Composed receive primitive — created lazily on first connect() so the
		// name/sink/arguments are settled (mirrors PHP ensure_patrons).
		this.sseIn = null;
	}

	/**
	 * Send path: a command routed in via TO={worker} (the Router peeled this
	 * node's name). Boot/steal the live connection, then route the bundled
	 * `[connect_worker_input, command]` pair through `_http` as one POST.
	 *
	 * @param {Array} message Positional Message; TO is the remainder past {worker}.
	 */
	fill( message ) {
		this.counter += 1;
		this.connect();

		const reader = this.name;
		const remainder = message[ TO ];
		const command = message.slice();
		if ( REPLY_NODES.includes( command[ FROM ] ) ) {
			command[ FROM ] = `${ names.SSE }:${ this.pid() }/${
				command[ FROM ]
			}`;
		}
		command[ TO ] =
			'' === remainder
				? `${ names.HTTP }/${ reader }`
				: `${ names.HTTP }/${ reader }/${ remainder }`;

		const connect = newMessage();
		connect[ TYPE ] = TM_COMMAND;
		connect[ TO ] = `${ names.HTTP }/topologies`;
		connect[ VALUE ] = { name: 'connect_worker_input', arguments: reader };

		// One POST: ride a pre-existing lock (the Router TIMER batch) or open our
		// own around just this pair so the mount + command share a server process.
		const http = Core.node( names.HTTP );
		const preLocked = !! ( http && http.locked );
		if ( http && ! preLocked ) {
			http.lock();
		}
		this.sink.fill( connect );
		this.sink.fill( command );
		if ( http && ! preLocked ) {
			http.flush();
		}
	}

	// Lazily build the composed SseIn (named `{worker}:sse-in`, subscribed to this
	// worker, forwarding parsed frames to the patron's own sink/target). Mirrors
	// PHP Remote_Source_Node::ensure_patrons.
	ensureSseIn() {
		if ( this.sseIn ) {
			return this.sseIn;
		}
		const sse = new SseInNode();
		sse.name = `${ this.name }:sse-in`;
		sse.arguments = this.arguments;
		sse.sink = this.sink;
		if ( this.target ) {
			sse.target = this.target;
		}
		this.sseIn = sse;
		return sse;
	}

	// Make this patron's SseIn the live stream, replacing whichever RemoteIpc held
	// it. Idempotent while already live (a steady poll stream doesn't reconnect).
	connect() {
		const sse = this.ensureSseIn();
		if ( RemoteIpcNode.active === this && sse._es ) {
			return;
		}
		if ( RemoteIpcNode.active && RemoteIpcNode.active !== this ) {
			RemoteIpcNode.active.close();
		}
		sse.start();
		RemoteIpcNode.active = this;
	}

	// Close the composed stream and release the live-connection claim.
	close() {
		this.sseIn?.close();
		if ( RemoteIpcNode.active === this ) {
			RemoteIpcNode.active = null;
		}
	}

	// Session pid, read from the composed SseIn's `connected` snoop.
	pid() {
		return this.sseIn?.pid() ?? null;
	}

	// Tear down the composed SseIn (close the stream, then unregister it from Core)
	// and release the active claim, then remove self.
	removeNode() {
		this.close();
		this.sseIn?.removeNode();
		this.sseIn = null;
		super.removeNode();
	}

	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Per-worker interactive command channel (Remote_IPC): cd onto it and commands ride to the remote worker.',
			accepts_fill: true,
			has_target: true,
			arguments: SseInNode.nodeSchema().arguments,
			commands: [],
		};
	}
}
