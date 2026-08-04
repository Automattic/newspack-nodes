/**
 * Heartbeat — the `_heartbeat` node. A silent poll node (like Metadata / Uptime)
 * that, on the Router TIMER, emits a `workers/heartbeat` command to refresh this
 * session's SSE slot TTL. Emitting on the TIMER lets the poke ride in the SAME
 * batched POST as the canvas polls (one request per tick) instead of its own
 * setInterval. The reply is consumed by `fill()` — never routed to the transcript.
 *
 * The exact slot lease is refreshed EXCLUSIVELY by this client poke (the
 * server's check_slot never refreshes it); without it the worker-partition slot
 * TTLs out and the browser reconnects. The server owns the TTL.
 */

import { TimerNode } from './timer-node';
import { Core } from './core';
import { TYPE, VALUE, TM_ERROR, TM_RESPONSE } from './message';

const LEASE_OWNER_RE = /^[1-9][0-9]*$/;
// @longform Matches Remote_Link_Node::HEARTBEAT_INTERVAL doing the identical
// job server-side, and clears SSE_Slot_Pool::$ttl (60s) four times over. 5s
// was 12x more often than the lease actually needs.
const POKE_INTERVAL_MS = 15000;

/**
 * The `_heartbeat` node: one poke per live lease, on every Router tick.
 *
 * A lease is registered per stream identity by `setSlot()` and forgotten by
 * `clearSlot()`; registering one arms the poke timer, dropping the last one
 * stops it. `lastHeartbeatResponse` / `lastHeartbeatError` hold the most recent
 * outcome — the only trace a reply leaves, since nothing is forwarded onward.
 */
export class HeartbeatNode extends TimerNode {
	/**
	 * Start leaseless: nothing is armed and nothing is poked until `setSlot()`
	 * registers the first lease.
	 */
	constructor() {
		super();
		// Most recently connected lease, retained for node status/debugging.
		this.slot = null;
		this.leaseOwner = null;
		// Stream identity is the map key; wire lease owner lives in the value.
		this._leases = new Map();
		this.lastHeartbeatResponse = null;
		this.lastHeartbeatError = null;
	}

	/**
	 * Consume a heartbeat reply. Only TM_RESPONSE and TM_ERROR are recorded;
	 * any other type is counted and dropped, because a reply never travels on
	 * to the transcript. A TM_ERROR, or a body that is not `success: true`,
	 * clears the prior green status and leaves the reason inspectable.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		const type = message[ TYPE ];
		if ( ! ( type & ( TM_RESPONSE | TM_ERROR ) ) ) {
			return;
		}
		const response = message[ VALUE ];
		const payload =
			response && 'object' === typeof response && 'payload' in response
				? response.payload
				: response;
		if ( type & TM_ERROR ) {
			this._recordFailure(
				this._safeError( payload, 'Heartbeat command failed' )
			);
			return;
		}
		if (
			! payload ||
			'object' !== typeof payload ||
			true !== payload.success
		) {
			this._recordFailure(
				this._safeError( payload, 'Heartbeat rejected' )
			);
			return;
		}
		this.lastHeartbeatResponse = Core.now();
		this.lastHeartbeatError = null;
	}

	/**
	 * Router TIMER subscriber: poke every live lease through the sink. An
	 * unauthenticated tick emits nothing at all — `command()` returns null
	 * until the session lands, and the next tick carries the pokes.
	 */
	fire() {
		if ( 0 === this._leases.size || ! this.sink ) {
			return;
		}
		for ( const lease of this._leases.values() ) {
			const m = this._pollMessage( lease );
			if ( ! m ) {
				return; // unauthenticated: the next tick carries it
			}
			this.counter++;
			this.sink.fill( m );
		}
	}

	/**
	 * Build one lease's poke: a `heartbeat` TM_COMMAND addressed to `target`,
	 * stamped FROM this node so the reply routes back to `fill()`, and marked
	 * LOCAL so the interpreter authorizes it.
	 *
	 * @param {Object} lease            The lease to refresh.
	 * @param {number} lease.slot       SSE slot the stream holds.
	 * @param {string} lease.leaseOwner Wire token proving ownership of that slot.
	 * @return {?Array} The signed command, or null when unauthenticated.
	 */
	_pollMessage( { slot, leaseOwner } ) {
		return this.command( 'heartbeat', [ String( slot ), leaseOwner ] );
	}

	/**
	 * Record a failed poke: drop the green status so a stale success cannot
	 * outlive it, and keep the reason for node status.
	 *
	 * @param {string} error Human-readable reason, already sanitized.
	 */
	_recordFailure( error ) {
		this.lastHeartbeatResponse = null;
		this.lastHeartbeatError = error;
	}

	/**
	 * Reduce a reply body to one short error line. Only the known scalar
	 * fields are read — a raw body is never retained or stringified — and the
	 * winner is trimmed, newline-flattened, and capped at 512 characters.
	 *
	 * @param {*}      payload  The decoded reply body, of whatever shape it arrived in.
	 * @param {string} fallback Used when no field carries a non-empty string.
	 * @return {string} The error line to record.
	 */
	_safeError( payload, fallback ) {
		const candidates =
			payload && 'object' === typeof payload
				? [ payload.error, payload.message, payload.reason ]
				: [ payload ];
		const detail = candidates.find(
			( value ) => 'string' === typeof value && '' !== value.trim()
		);
		return detail
			? detail
					.trim()
					.replace( /[\r\n]+/g, ' ' )
					.slice( 0, 512 )
			: fallback;
	}

	/**
	 * Record one stream's exact lease and arm the poke timer. Both halves of
	 * the lease are validated because a missing or malformed owner is a
	 * protocol error, not a value to poke with — it throws rather than leasing
	 * a slot the server will refuse.
	 *
	 * @param {number}        slot          SSE slot the stream holds.
	 * @param {string}        leaseOwner    Wire token proving ownership; a canonical positive decimal.
	 * @param {Object|string} [streamOwner] Stream identity keying the lease; defaults to this node.
	 */
	setSlot( slot, leaseOwner, streamOwner = this ) {
		if ( ! Number.isInteger( slot ) || slot < 0 ) {
			throw new Error( 'Heartbeat slot must be a non-negative integer' );
		}
		if (
			'string' !== typeof leaseOwner ||
			! LEASE_OWNER_RE.test( leaseOwner )
		) {
			throw new Error(
				'Heartbeat lease owner must be a canonical positive decimal string'
			);
		}
		this._leases.set( streamOwner, { slot, leaseOwner } );
		this.slot = slot;
		this.leaseOwner = leaseOwner;
		this.lastHeartbeatResponse = null;
		this.lastHeartbeatError = null;
		this.setTimer( POKE_INTERVAL_MS );
	}

	/**
	 * Forget one stream identity's lease, or every lease on graph teardown.
	 * The reported `slot` / `leaseOwner` fall back to the newest surviving
	 * lease, and the poke timer stops once none remain.
	 *
	 * @param {Object|string|null} [streamOwner] Stream identity to forget; null forgets every lease.
	 * @return {boolean} False when that stream held no lease; true otherwise.
	 */
	clearSlot( streamOwner = null ) {
		if ( null === streamOwner ) {
			this._leases.clear();
		} else if ( ! this._leases.delete( streamOwner ) ) {
			return false;
		}
		const remaining = [ ...this._leases.values() ];
		const latest = remaining.at( -1 ) ?? null;
		this.slot = latest?.slot ?? null;
		this.leaseOwner = latest?.leaseOwner ?? null;
		if ( 0 === remaining.length ) {
			this.stopTimer();
		}
		return true;
	}

	/**
	 * Console palette entry — hidden, takes no arguments, and accepts no
	 * user-routed fill (its only input is its own poke reply).
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Pokes `workers/heartbeat` to refresh the SSE slot TTL.',
			accepts_fill: false,
			arguments: [],
			commands: [],
		};
	}
}
