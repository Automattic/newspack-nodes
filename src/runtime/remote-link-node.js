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

import { Core } from './core';
import { Node } from './node';
import { SseInNode } from './sse-in-node';
import { HttpOutNode } from './http-out-node';
import { HeartbeatNode } from './heartbeat-node';
import { CommandClient } from './command-client';
import names from './reserved-node-names.json';

export class RemoteLinkNode extends Node {
	constructor() {
		super();
		// CommandClient for the composed HttpOut; callers may assign a seam before
		// first use, else ensureChildren builds one from the parsed baseUrl/nonce.
		this.client = null;
		this.sseIn = null;
		this.httpOut = null;
		this.heartbeat = null;
		// A RemoteLink is a log/topic SUBSCRIPTION: every received record goes to
		// the link's target, so its SseIn re-homes any server-side TO the records
		// carry (PARTITION replays do). RemoteIpc (pivoted IPC) overrides this to
		// false so worker reply frames keep their TO=FROM breadcrumb routing.
		this.rehomeReceived = true;
		// Optional consumer hook fired with the SseIn's `connected` payload (after
		// the internal slot bridge) — lets a graph track which link's stream is live
		// (e.g. the console's ssePid as the active worker changes).
		this.onConnected = null;
		// Optional consumer hook fired AFTER close() finishes — lets a graph reset
		// state tied to this stream (e.g. the console's ssePid when a steal closes
		// the old active link before the new one handshakes).
		this.onClose = null;
	}

	// Open the inbound stream (children built lazily on first use). An optional
	// `positions` seed (`{ <sub>: { <partition>: 'start'|'end'|{seg,off} } }`)
	// seeks the server cursor — the Overview tab passes 'start' for 24h replay;
	// omitting it tail-seeks (the live-follow default).
	connect( positions = null ) {
		this.ensureChildren();
		this.sseIn.positions = positions;
		this.sseIn.start();
	}

	// Re-point the stream at a new subscription (the dashboards' selectLog), with
	// an optional `positions` seek seed (omitted → tail-seek).
	setSubscribe( subscribe, positions = null ) {
		this.ensureChildren();
		this.sseIn.close();
		this.sseIn.subscribe = subscribe;
		this.sseIn.positions = positions;
		this.sseIn.start();
	}

	// Send a command out through this link's own HttpOut.
	send( message ) {
		this.ensureChildren();
		this.httpOut.fill( message );
	}

	/**
	 * Create + register the three children and wire the connected→slot bridge.
	 * Idempotent — the first send() or connect() builds them; later calls no-op.
	 */
	ensureChildren() {
		if ( this.sseIn ) {
			return;
		}

		const sse = new SseInNode();
		sse.arguments = this.arguments; // `{subscribe} {baseUrl} {nonce}`
		sse.sink = this.sink;
		if ( this.target ) {
			sse.target = this.target;
		}
		// Subscriptions re-home received records to the target; RemoteIpc opts out
		// (see `rehomeReceived`) so its worker reply frames keep TO=FROM routing.
		sse.homeToTarget = this.rehomeReceived;
		this.sseIn = sse;

		let http;
		if ( Core.node( names.HTTP ) ) {
			http = Core.node( names.HTTP );
		} else {
			http = new HttpOutNode();
			http.name = names.HTTP;
			http.sink = this.sink;
		}
		http.client =
			this.client ||
			new CommandClient( { baseUrl: sse.baseUrl, nonce: sse.nonce } );
		this.httpOut = http;

		let hb;
		if ( Core.node( names.HEARTBEAT ) ) {
			hb = Core.node( names.HEARTBEAT );
		} else {
			hb = new HeartbeatNode();
			hb.name = names.HEARTBEAT;
			hb.sink = this.sink;
			// Poke routes through THIS link's own HttpOut to the request-scope `workers` CI.
			hb.target = `${ names.HTTP }/workers`;
			hb.setTimer();
		}
		this.heartbeat = hb;

		// Slot bridge: the SseIn's `connected` handshake carries the slot the
		// Heartbeat must keep alive (mirrors the per-dashboard registration it
		// replaces). The envelope is a string (TM_INFO), parsed into sse.sessionSlot;
		// the slot-pool keep-alive keys on (user, ip, slot) — no partition.
		sse.register( 'CONNECTED', this.name, ( payload ) => {
			const slot = sse.slot();
			if ( Number.isInteger( slot ) && slot >= 0 ) {
				hb.setSlot( slot );
			} else {
				hb.clearSlot();
			}
			this.onConnected?.( payload );
			return true;
		} );
	}

	// Tear down the children (unregister + close) then remove self. close() first
	// because the children's removeNode (Node/TimerNode) unregisters but does NOT
	// close the SseIn's live EventSource — teardown must, or the stream leaks.
	removeNode() {
		this.close();
		this.sseIn?.unregister( 'CONNECTED', this.name );
		this.heartbeat?.removeNode();
		this.httpOut?.removeNode();
		this.sseIn?.removeNode();
		this.sseIn = null;
		this.httpOut = null;
		this.heartbeat = null;
		super.removeNode();
	}

	// Close the inbound stream and forget the slot (nothing to keep alive), then
	// fire the consumer's onClose hook.
	close() {
		this.sseIn?.close();
		this.heartbeat?.clearSlot();
		this.onClose?.();
	}

	// `connect_node` points BOTH this node's target AND its composed SseIn, so
	// records received after the connection re-home to the new target (the SseIn
	// re-homes each frame to its own `target`). Before the children exist,
	// ensureChildren() seeds the SseIn's target from `this.target`, so the base
	// set is enough; once built, the live SseIn must be updated directly.
	connectNode( target ) {
		super.connectNode( target );
		if ( this.sseIn ) {
			this.sseIn.target = target;
		}
	}

	// Resume seed (last seen `{seg,off}` per sub/partition) so a reconnect picks up
	// exactly where the stream left off; null (→ tail) when nothing's been seen.
	resumePositions() {
		return this.sseIn?.resumePositions() ?? null;
	}

	// Session pid, read from the composed SseIn's `connected` snoop.
	pid() {
		return this.sseIn?.pid() ?? null;
	}

	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Full-duplex SSE+HTTP channel: composes a SseIn, HttpOut and Heartbeat as one node.',
			accepts_fill: false,
			has_target: true,
			arguments: SseInNode.nodeSchema().arguments,
			commands: [],
		};
	}
}
