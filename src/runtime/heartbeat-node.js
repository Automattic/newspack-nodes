/**
 * Heartbeat — the `_heartbeat` node, which keeps this page's SSE slot leases
 * alive by poking `workers/heartbeat` on a cadence.
 *
 * A lease is refreshed EXCLUSIVELY by this client poke. The server's
 * `check_slot` inspects the lease on every drain iteration and never extends
 * it, so a stream that stops poking loses its lease at the TTL: the check
 * fails, the server sends `disconnect`, and the browser reconnects. The server
 * still owns the TTL — the client only says "still here".
 *
 * Riding the Router TIMER rather than a `setInterval` of its own puts the poke
 * on the same wall-clock grid as every canvas poll (ADR-17), so it travels in
 * that tick's one batched POST instead of a request of its own. Each reply
 * comes back TO=FROM to `fill()` (ADR-7) and stops there: nothing is forwarded
 * to the transcript, and this node publishes no state.
 */

import { TimerNode } from './timer-node';
import { Core } from './core';
import { TYPE, VALUE, TM_ERROR, TM_RESPONSE } from './message';

/**
 * A wire lease owner: a canonical positive decimal, carried as a string.
 *
 * PHP mints the owner with `random_int( 1, PHP_INT_MAX )`, so a token can
 * exceed `Number.MAX_SAFE_INTEGER`; parsing one here and re-stringifying it
 * would round it and poke with a lease nobody holds. Zero is excluded because
 * the slot pointer reserves it as the release tombstone.
 */
const LEASE_OWNER_RE = /^[1-9][0-9]*$/;

/**
 * Milliseconds between pokes, per live lease.
 *
 * It matches `Remote_Link_Node::HEARTBEAT_INTERVAL`, which does the identical
 * job server-side, and divides the lease TTL — 60 seconds by default, floored
 * at 45 by `SSE_Slot_Pool::ttl()` — so one lost poke still leaves a refresh
 * before expiry.
 */
const POKE_INTERVAL_MS = 15000;

/**
 * The `SSE_Slot_Pool` lease state naming a slot released out from under this
 * stream. The server reports it as a refusal, but it is a race with a stream
 * that already closed rather than a fault. Mirrors
 * `Remote_Link_Node::RELEASED_SLOT`.
 */
const RELEASED_SLOT = 'slot_released';

/**
 * The `_heartbeat` node: one poke per live lease, every `POKE_INTERVAL_MS`.
 *
 * A stream registers its lease with `setSlot()` and drops it with
 * `clearSlot()`; the first registration arms the poke timer and the last
 * removal stops it, so a page holding no stream costs nothing. One shared
 * `_heartbeat` serves every stream — `mountExospine` wires it as a backbone
 * singleton, and each `RemoteLinkNode` keys its own lease by its own identity.
 *
 * `lastHeartbeatResponse` / `lastHeartbeatError` hold the most recent outcome.
 * They are the only trace a reply leaves.
 */
export class HeartbeatNode extends TimerNode {
	/**
	 * Start leaseless: nothing is armed and nothing is poked until `setSlot()`
	 * registers the first lease.
	 */
	constructor() {
		super();
		// Newest live lease, mirrored flat for inspection.
		this.slot = null;
		this.leaseOwner = null;
		// Stream identity is the map key; wire lease owner lives in the value.
		this._leases = new Map();
		this.lastHeartbeatResponse = null;
		this.lastHeartbeatError = null;
	}

	/**
	 * Consume a heartbeat reply — where every poke ends, since nothing is
	 * forwarded on. Only TM_RESPONSE and TM_ERROR are read; any other type is
	 * counted and dropped. A command reply arrives wrapped as
	 * `{ name, arguments, payload }`, and anything else arrives as itself.
	 * A failure clears the green status and leaves its reason inspectable;
	 * a success stamps the time.
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
		// Both failure kinds, ONE verdict — as Remote_Link_Node reads them.
		let failure = null;
		if ( type & TM_ERROR ) {
			failure = this._safeError( payload, 'Heartbeat command failed' );
		} else if (
			! payload ||
			'object' !== typeof payload ||
			true !== payload.success
		) {
			failure = this._safeError( payload, 'Heartbeat rejected' );
		}
		if ( null !== failure ) {
			// A released slot is a race, not a fault: no record, no log.
			if ( ! failure.includes( RELEASED_SLOT ) ) {
				this._recordFailure( failure );
				// Rate-limited: a standing failure would log every tick.
				this.printLessOften(
					`ERROR: client heartbeat failed - ${ failure }`
				);
			}
			return;
		}
		this.lastHeartbeatResponse = Core.now();
		this.lastHeartbeatError = null;
	}

	/**
	 * Router TIMER subscriber: poke every live lease through the sink.
	 *
	 * An unauthenticated tick emits nothing. `command()` refuses to mint until
	 * the session lands, and that readiness is per-page rather than per-lease,
	 * so the first refusal decides the whole loop. `markDue()` keeps the unsent
	 * tick from spending the cadence, and the next one carries the pokes.
	 */
	fire() {
		if ( 0 === this._leases.size || ! this.sink ) {
			return;
		}
		for ( const lease of this._leases.values() ) {
			const m = this._pollMessage( lease );
			if ( ! m ) {
				this.markDue();
				return;
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
	 * winner is trimmed, newline-flattened, and capped at 512 characters so a
	 * remote string cannot pin an unbounded value in node state.
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
	 * Record one stream's exact lease and arm the poke timer. Both halves are
	 * validated because a missing or malformed owner is a protocol error, not
	 * a value to poke with — it throws rather than leasing a slot the server
	 * will refuse. The status pair resets, since the new lease has no outcome
	 * yet.
	 *
	 * @param {number}        slot          SSE slot the stream holds.
	 * @param {string}        leaseOwner    Wire token proving ownership; a canonical positive decimal.
	 * @param {Object|string} [streamOwner] Stream identity keying the lease; defaults to this node.
	 * @throws {Error} When the slot is not a non-negative integer, or the owner is not a canonical positive decimal string.
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
