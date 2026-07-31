/**
 * RemoteLinkNode — the full-duplex "be the browser" SSE+HTTP channel, as one
 * node. It composes the three children every SSE dashboard and the console
 * worker attachment used to wire by hand:
 *
 *   {name}:sse-in     SseIn     — inbound EventSource stream (frames → link sink/target)
 *   {name}:http       HttpOut   — outbound /command POST boundary
 *   {name}:heartbeat  Heartbeat — slot keepalive, poking `workers` via {name}:http
 *
 * plus the `connected → lease` bridge (the SseIn's connect handshake carries
 * the exact slot + lease owner the Heartbeat must keep alive). A dashboard
 * makes ONE RemoteLink instead of three nodes + a bridge registration;
 * RemoteIpc extends it with the worker-relay send and single-connection steal.
 *
 * Mirrors the PHP Remote_Source_Node, which is a patron owning an SSE_In_Node +
 * HTTP_Out_Node. The durable offsetlog that distinguishes aggregation is a
 * PHP-only `Remote_Source extends Remote_Link` concern — the browser has no
 * durable cursor, so JS ships only RemoteLink + RemoteIpc.
 */

import { Core } from './core';
import { Node, parseSchemaArgs } from './node';
import { SseInNode } from './sse-in-node';
import { CommandClient } from './command-client';
import names from './reserved-node-names.json';

export class RemoteLinkNode extends Node {
	constructor() {
		super();
		// CommandClient for the HttpOut; ensureChildren builds one if unset.
		this.client = null;
		this.sseIn = null;
		this.httpOut = null;
		this.heartbeat = null;
		this.subscribe = '';
		// Override the SseIn REST route (e.g. /log/stream); '' keeps default.
		this.endpoint = '';
		// A RemoteLink is a SUBSCRIPTION: SseIn re-homes records to target.
		this.rehomeReceived = true;
		// Optional hook fired with the SseIn's `connected` payload.
		this.onConnected = null;
		// Optional hook fired AFTER close() — reset stream-tied state.
		this.onClose = null;
	}

	get arguments() {
		return super.arguments;
	}

	set arguments( value ) {
		super.arguments = value;
		this.subscribe = '';
		parseSchemaArgs( this, value );
	}

	// Re-point the stream at a new subscription; optional `positions` seed.
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

	// Tear down OUR SseIn — close() first (removeNode won't close the stream).
	removeNode() {
		this.close();
		this.sseIn?.unregister( 'CONNECTING', this.name );
		this.sseIn?.unregister( 'CONNECTED', this.name );
		this.sseIn?.unregister( 'DISCONNECTED', this.name );
		this.sseIn?.removeNode();
		this.sseIn = null;
		this.httpOut = null;
		this.heartbeat = null;
		super.removeNode();
	}

	// `connect_node` is a source link's start lifecycle on the canvas.
	connectNode( target ) {
		this._assertConfigured();
		super.connectNode( target );
		if ( this.sseIn ) {
			this.sseIn.target = target;
		}
		if ( ! this.sseIn?._es ) {
			this.connect();
		}
	}

	// Open the inbound stream; optional `positions` seed seeks the cursor.
	connect( positions = null ) {
		this.ensureChildren();
		this.sseIn.positions = positions;
		this.sseIn.start();
	}

	/**
	 * Create + register the three children and wire the connected→slot bridge.
	 * Idempotent — the first send() or connect() builds them; later calls no-op.
	 */
	ensureChildren() {
		this._assertConfigured();
		if ( this.sseIn ) {
			return;
		}

		const sse = new SseInNode();
		sse.arguments = this.arguments; // `{subscribe}`; baseUrl/nonce from global
		if ( this.endpoint ) {
			sse.endpoint = this.endpoint;
		}
		sse.sink = this.sink;
		if ( this.target ) {
			sse.target = this.target;
		}
		// Subscriptions re-home records to target; RemoteIpc opts out.
		sse.homeToTarget = this.rehomeReceived;
		this.sseIn = sse;

		// `_http` + `_heartbeat` are backbone singletons; reuse + configure.
		const http = Core.node( names.HTTP );
		http.client = this.client || CommandClient.fromGlobal();
		this.httpOut = http;

		// Not armed here: the connection lifecycle below arms/stops it.
		const hb = Core.node( names.HEARTBEAT );
		this.heartbeat = hb;

		// Each opening/closed stream has no valid lease until CONNECTED.
		const clearLease = () => {
			hb.clearSlot( this );
			return true;
		};
		sse.register( 'CONNECTING', this.name, clearLease );
		sse.register( 'DISCONNECTED', this.name, clearLease );

		// Lease bridge: keep link identity separate from the wire owner token.
		sse.register( 'CONNECTED', this.name, ( payload ) => {
			const slot = sse.slot();
			const leaseOwner = sse.leaseOwner();
			if (
				Number.isInteger( slot ) &&
				slot >= 0 &&
				'string' === typeof leaseOwner
			) {
				hb.setSlot( slot, leaseOwner, this );
			} else {
				hb.clearSlot( this );
			}
			this.onConnected?.( payload );
			return true;
		} );
	}

	// Removing the output edge closes the stream and its heartbeat slot.
	disconnectNode( target = '' ) {
		super.disconnectNode( target );
		if ( this.sseIn ) {
			this.sseIn.target = '';
		}
		this.close();
	}

	// Close the inbound stream, forget the slot, then fire the onClose hook.
	close() {
		this.sseIn?.close();
		this.heartbeat?.clearSlot( this );
		this.onClose?.();
	}

	_assertConfigured() {
		if ( '' === this.subscribe ) {
			throw new Error( 'RemoteLink requires an SSE subscription' );
		}
	}

	// Composite stat delegation: surface the children's byte tallies.
	get counter() {
		return this.sseIn ? this.sseIn.counter : super.counter;
	}
	// Derived from the sseIn child; base fill()'s `counter += 1` is a no-op.
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

	// Resume seed (last `{segment,offset}` per sub/partition); null → tail.
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
