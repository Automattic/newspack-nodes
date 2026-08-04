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
import { defaultTransport } from './command-transport';
import names from './reserved-node-names.json';

/**
 * A resume seed: the next-record `{segment, offset}` for each partition
 * directory the stream has delivered, as `SseIn.resumePositions()` builds it.
 * Passed back to the server as the `positions=` seek so a reopened stream
 * neither gaps nor replays.
 *
 * @typedef {Object<string,{segment:number,offset:number}>} ResumePositions
 */

/**
 * The composed SSE+HTTP channel: one node standing in for an SseIn stream, the
 * shared HttpOut command boundary, and the Heartbeat that keeps the stream's
 * slot lease alive.
 *
 * `subscribe` (the sole positional argument) names what the stream carries, and
 * nothing opens until `connect()`, `send()` or `connectNode()` builds the
 * children. Records arrive on the link's own `sink`/`target`, so a consumer
 * wires a RemoteLink exactly as it would wire any other source node.
 */
export class RemoteLinkNode extends Node {
	/**
	 * Start unconfigured and childless: `ensureChildren()` builds the stream on
	 * the first connect or send, and `_assertConfigured()` refuses until
	 * `arguments` has supplied a subscription.
	 */
	constructor() {
		super();
		// Transport for the HttpOut; ensureChildren defaults it if unset.
		this.client = null;
		this.sseIn = null;
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

	/**
	 * @return {string[]} The argument tokens last assigned.
	 */
	get arguments() {
		return super.arguments;
	}

	/**
	 * Take the positional tokens and run the Schema_Reflection walk, which
	 * assigns the one declared argument, `subscribe`. The reset first means a
	 * re-assignment cannot inherit the previous subscription.
	 *
	 * @param {string[]} value Positional tokens; the first is the comma-separated subscription list.
	 */
	set arguments( value ) {
		super.arguments = value;
		this.subscribe = '';
		parseSchemaArgs( this, value );
	}

	/**
	 * Re-point the stream at a new subscription, closing and reopening it.
	 *
	 * @param {string[]}         subscribe Subscriptions the reopened stream carries.
	 * @param {?ResumePositions} positions Where to resume each partition; null tail-seeks.
	 */
	setSubscribe( subscribe, positions = null ) {
		this.ensureChildren();
		this.sseIn.close();
		this.sseIn.subscribe = subscribe;
		this.sseIn.positions = positions;
		this.sseIn.start();
	}

	/**
	 * Send out through the ONE `_http` boundary — every browser graph has
	 * exactly one, and that shared buffer is what lets a tick's commands batch
	 * into a single POST regardless of which TO each of them carries.
	 *
	 * @param {Array} message Positional Message to post.
	 */
	send( message ) {
		this.ensureChildren();
		Core.node( names.HTTP ).fill( message );
	}

	/**
	 * Tear down OUR SseIn. `close()` runs first because `removeNode()` alone
	 * would leave the EventSource open, and the shared `_http` / `_heartbeat`
	 * backbone is left for the graph to tear down.
	 */
	removeNode() {
		this.close();
		this.sseIn?.unregister( 'CONNECTING', this.name );
		this.sseIn?.unregister( 'CONNECTED', this.name );
		this.sseIn?.unregister( 'DISCONNECTED', this.name );
		this.sseIn?.removeNode();
		this.sseIn = null;
		this.heartbeat = null;
		super.removeNode();
	}

	/**
	 * `connect_node` is a source link's start lifecycle on the canvas: wiring
	 * the output edge also points the stream at it and opens the stream.
	 *
	 * @param {string} target Node path each received record is re-homed to.
	 */
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

	/**
	 * Open the inbound stream, building the children on first use.
	 *
	 * @param {?ResumePositions} positions Where to resume each partition; null tail-seeks.
	 */
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

		/** @type {SseInNode & import('./sse-in-node').PatronConfigured} */
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

		// Backbone singletons; configure, never alias per-link.
		Core.node( names.HTTP ).client = this.client || defaultTransport();

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

	/**
	 * Removing the output edge closes the stream and its heartbeat slot —
	 * a link with nowhere to deliver has no reason to hold one open.
	 *
	 * @param {string} target Edge to drop; the base clears the single target.
	 */
	disconnectNode( target = '' ) {
		super.disconnectNode( target );
		if ( this.sseIn ) {
			this.sseIn.target = '';
		}
		this.close();
	}

	/**
	 * Close the inbound stream, forget this link's heartbeat slot, then fire
	 * the `onClose` hook so the owner can reset stream-tied state.
	 */
	close() {
		this.sseIn?.close();
		this.heartbeat?.clearSlot( this );
		this.onClose?.();
	}

	/**
	 * Refuse every operation that would open a stream until a subscription has
	 * been supplied — an unsubscribed EventSource has nothing to carry.
	 *
	 * @throws {Error} When `subscribe` is still empty.
	 */
	_assertConfigured() {
		if ( '' === this.subscribe ) {
			throw new Error( 'RemoteLink requires an SSE subscription' );
		}
	}

	/**
	 * Composite stat delegation: the records arrive on the SseIn child, so its
	 * tally is the link's own until a stream exists.
	 *
	 * @return {number} Records received.
	 */
	get counter() {
		return this.sseIn ? this.sseIn.counter : super.counter;
	}

	/**
	 * Ignored — the count is derived from the sseIn child, which makes the base
	 * `fill()`'s `counter++` a no-op here.
	 *
	 * @param {number} _v Discarded.
	 */
	set counter( _v ) {}

	/**
	 * @return {number} Bytes the composed stream has received.
	 */
	get bytesRead() {
		return this.sseIn ? this.sseIn.bytesRead : super.bytesRead;
	}

	/**
	 * Egress leaves through the shared `_http`, not this link, so the base
	 * tally stands.
	 *
	 * @return {number} Bytes written.
	 */
	get bytesWritten() {
		return super.bytesWritten;
	}

	/**
	 * @return {number} Largest single frame the composed stream has seen.
	 */
	get largestMsgSent() {
		return this.sseIn ? this.sseIn.largestMsgSent : super.largestMsgSent;
	}

	/**
	 * The seed a reconnect resumes from, one entry per partition seen.
	 *
	 * @return {?ResumePositions} Positions to resume at, or null to tail-seek.
	 */
	resumePositions() {
		return this.sseIn?.resumePositions() ?? null;
	}

	/**
	 * The remote session's process id, snooped from the SseIn's `connected`
	 * handshake. RemoteIpc puts it in the `_sse:{pid}` reply address.
	 *
	 * @return {?number} Session pid, or null before the handshake lands.
	 */
	pid() {
		return this.sseIn?.pid() ?? null;
	}

	/**
	 * Console-palette entry. It borrows SseIn's argument list, since the
	 * subscription is the one thing that configures both.
	 *
	 * @return {Object} The node schema.
	 */
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
