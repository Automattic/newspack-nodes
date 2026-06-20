/**
 * RemoteLinkNode — the full-duplex "be the browser" SSE+HTTP channel, as one
 * node. It composes the three children every SSE dashboard and the console
 * worker-pivot used to wire by hand:
 *
 *   {name}:sse-in     SseIn     — inbound EventSource stream (frames → link sink/target)
 *   {name}:http       HttpOut   — outbound /command POST boundary
 *   {name}:heartbeat  Heartbeat — slot keepalive, poking `workers` via {name}:http
 *
 * plus the `connected → slot` bridge (the SseIn's connect handshake carries the
 * slot the Heartbeat must keep alive). A dashboard makes ONE RemoteLink instead
 * of three nodes + a bridge registration; RemoteIpc extends it with the
 * worker-relay send and the single-connection steal.
 *
 * Mirrors the PHP Remote_Source_Node, which is a patron owning an SSE_In_Node +
 * HTTP_Out_Node. The durable offsetlog that distinguishes aggregation is a
 * PHP-only `Remote_Source extends Remote_Link` concern — the browser has no
 * durable cursor, so JS ships only RemoteLink + RemoteIpc.
 */

import { Node } from './node';
import { SseInNode } from './sse-in-node';
import { HttpOutNode } from './http-out-node';
import { HeartbeatNode } from './heartbeat-node';
import { CommandClient } from './command_client';

export class RemoteLinkNode extends Node {
	constructor() {
		super();
		// CommandClient for the composed HttpOut; callers may assign a seam before
		// first use, else ensureChildren builds one from the parsed baseUrl/nonce.
		this.client = null;
		this.sseIn = null;
		this.httpOut = null;
		this.heartbeat = null;
	}

	// Names of the three composed children, derived from this link's name.
	sseInName() {
		return `${ this.name }:sse-in`;
	}
	httpName() {
		return `${ this.name }:http`;
	}
	heartbeatName() {
		return `${ this.name }:heartbeat`;
	}

	/**
	 * Create + register the three children and wire the connected→slot bridge.
	 * Idempotent — the first send() or connect() builds them; later calls no-op.
	 */
	ensureChildren() {
		if ( this.sseIn ) {
			return;
		}

		// Setting `.name` registers the node in Core (Node's name setter), so no
		// explicit registerNode call — a second one would collide.
		const sse = new SseInNode();
		sse.name = this.sseInName();
		sse.arguments = this.arguments; // `{subscribe} {baseUrl} {nonce}`
		sse.sink = this.sink;
		if ( this.target ) {
			sse.target = this.target;
		}
		this.sseIn = sse;

		const http = new HttpOutNode();
		http.name = this.httpName();
		http.client =
			this.client ||
			new CommandClient( { baseUrl: sse.baseUrl, nonce: sse.nonce } );
		http.sink = this.sink;
		this.httpOut = http;

		const hb = new HeartbeatNode();
		hb.name = this.heartbeatName();
		hb.sink = this.sink;
		// Poke routes through THIS link's own HttpOut to the request-scope `workers` CI.
		hb.target = `${ this.httpName() }/workers`;
		hb.setTimer();
		this.heartbeat = hb;

		// Slot bridge: the SseIn's `connected` handshake carries the slot the
		// Heartbeat must keep alive (mirrors the per-dashboard registration it replaces).
		sse.register( 'connected', this.name, ( payload ) => {
			const slot =
				payload && Number.isInteger( payload.slot )
					? payload.slot
					: null;
			const partition =
				payload && Number.isInteger( payload.partition )
					? payload.partition
					: -1;
			if ( null !== slot && slot >= 0 ) {
				hb.setSlot( slot, partition );
			} else {
				hb.clearSlot();
			}
			return true;
		} );
	}

	// Open the inbound stream (children built lazily on first use).
	connect() {
		this.ensureChildren();
		this.sseIn.start();
	}

	// Close the inbound stream and forget the slot (nothing to keep alive).
	close() {
		this.sseIn?.close();
		this.heartbeat?.clearSlot();
	}

	// Re-point the stream at a new subscription (the dashboards' selectLog).
	setSubscribe( subscribe ) {
		this.ensureChildren();
		this.sseIn.close();
		this.sseIn.subscribe = subscribe;
		this.sseIn.start();
	}

	// Send a command out through this link's own HttpOut.
	send( message ) {
		this.ensureChildren();
		this.httpOut.fill( message );
	}

	// Session pid, read from the composed SseIn's `connected` snoop.
	pid() {
		return this.sseIn?.pid() ?? null;
	}

	// Tear down the children (unregister + close) then remove self.
	removeNode() {
		this.sseIn?.unregister( 'connected', this.name );
		this.heartbeat?.removeNode();
		this.httpOut?.removeNode();
		this.sseIn?.removeNode();
		this.sseIn = null;
		this.httpOut = null;
		this.heartbeat = null;
		super.removeNode();
	}

	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Full-duplex SSE+HTTP channel: composes a SseIn, HttpOut and Heartbeat as one node.',
			accepts_fill: true,
			has_target: true,
			arguments: SseInNode.nodeSchema().arguments,
			commands: [],
		};
	}
}
