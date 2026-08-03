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

export class HeartbeatNode extends TimerNode {
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

	// Consume replies; errors clear prior green status and remain inspectable.
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

	// Router TIMER subscriber: fire() pokes each complete live lease.
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

	// Poke TM_COMMAND to this.target; FROM=name reply path, LOCAL authorizes.
	_pollMessage( { slot, leaseOwner } ) {
		return this.command( 'heartbeat', [ String( slot ), leaseOwner ] );
	}

	// Record one stream's exact lease; a missing owner is a protocol error.
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

	// Forget one stream identity's lease, or every lease on graph teardown.
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

	_recordFailure( error ) {
		this.lastHeartbeatResponse = null;
		this.lastHeartbeatError = error;
	}

	// Read only known scalar error fields; never retain/stringify a raw body.
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
