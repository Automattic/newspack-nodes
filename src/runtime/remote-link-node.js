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

		// `_http` (egress POST) + `_heartbeat` (slot keepalive) are backbone
		// singletons (mountExospine owns them, incl. the heartbeat's fixed
		// `_http/workers` target); reuse + configure. `_http` carries this link's
		// command client; arm the heartbeat's TIMER hitchhike so it pokes once a slot
		// is bridged in (fire() no-ops until then).
		const http = Core.node( names.HTTP );
		http.client =
			this.client ||
			new CommandClient( { baseUrl: sse.baseUrl, nonce: sse.nonce } );
		this.httpOut = http;

		const hb = Core.node( names.HEARTBEAT );
		hb.setTimer();
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

	// Tear down OUR own (unnamed) SseIn — close() first, because its removeNode
	// unregisters but does NOT close the live EventSource (the stream would leak).
	// `_http`/`_heartbeat` are backbone singletons (mountExospine owns them); leave
	// them for the graph to tear down, or a co-mounted link's reinit finds them gone.
	removeNode() {
		this.close();
		this.sseIn?.unregister( 'CONNECTED', this.name );
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

	// Composite stat delegation (mirrors PHP Remote_Link): this link does no wire
	// I/O itself — its SseIn child reads the stream and its HttpOut child POSTs — so
	// surface THEIR byte tallies, not the link's own zeros.
	get counter() {
		return this.sseIn ? this.sseIn.counter : super.counter;
	}
	// Derived from the sseIn child — the pass-through link tallies nothing of its
	// own, so base fill()'s `counter += 1` is a no-op (avoids a getter-only write).
	set counter( _v ) {}
	get bytesRead() {
		return this.sseIn ? this.sseIn.bytesRead : super.bytesRead;
	}
	get bytesWritten() {
		return super.bytesWritten;
	}
	get largestMsgSent() {
		return this.sseIn ? this.sseIn.largestMsgSent : super.largestMsgSent;
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

	// Wall-clock ms of the last frame the composed (unnamed) SseIn received — the
	// stream-liveness clock behind dashboards' "Xs ago" staleness. Passthrough so
	// callers read it by the RemoteLink's own name instead of reaching into
	// `.sseIn`; null before the first connect or after a close.
	lastEventTime() {
		return this.sseIn?.lastEventTime ?? null;
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
