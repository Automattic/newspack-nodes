/**
 * Heartbeat — the `_heartbeat` node. A silent poll node (like Metadata / Uptime)
 * that, on the Router TIMER, emits a `workers/heartbeat` command to refresh this
 * session's SSE slot TTL. Emitting on the TIMER lets the poke ride in the SAME
 * batched POST as the canvas polls (one request per tick) instead of its own
 * setInterval. The reply is consumed by `fill()` — never routed to the transcript.
 *
 * The slot is refreshed EXCLUSIVELY by this client poke (the server's check_slot
 * never refreshes); without it the worker-partition slot TTLs out and the browser
 * reconnects every ~minute. Poke at half the TTL so one missed poke survives.
 */

import { TimerNode } from './timer-node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from './message';

// Slot TTL (s) requested in each poke, and the throttle (half the TTL) so a
// single missed tick still leaves the slot alive.
const SLOT_TTL_S = 10;
const POKE_INTERVAL_MS = 5000;

export class HeartbeatNode extends TimerNode {
	constructor() {
		super();
		// The SSE slot to refresh; null until the SSE stream connects (and cleared
		// when it closes). The slot pool keeps alive on (user, ip, slot) — no
		// partition, so the heartbeat doesn't track one.
		this.slot = null;
	}

	// Hitchhike the Router TIMER and let the base fireCb() throttle to POKE_INTERVAL_MS
	// (half the slot TTL, so a single missed tick still leaves the slot alive).
	setTimer() {
		super.setTimer( POKE_INTERVAL_MS );
	}

	// Consume the heartbeat reply; it carries no canvas state, so swallow it.
	fill( message ) {
		this.counter += 1;
		void message;
	}

	// Router TIMER subscriber: the base fireCb() throttles to POKE_INTERVAL_MS, so
	// fire() just pokes the slot — only while a worker stream slot is held (the poke
	// is meaningless without one).
	fire() {
		if ( null === this.slot || ! this.sink ) {
			return;
		}
		this.counter += 1;
		this.sink.fill( this._pollMessage() );
	}

	// Build the poke TM_COMMAND, addressed to this.target — the REST `workers` CI
	// via the session boundary (`_sse` wraps FROM into the private reply pivot;
	// the slot pool's heartbeat verb lives on `workers`, not on the per-worker IPC
	// interpreter). FROM = own name is the reply pivot; LOCAL taints it so the browser interpreter
	// authorizes it.
	_pollMessage() {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = this.name;
		m[ TO ] = this.target;
		m[ VALUE ] = {
			name: 'heartbeat',
			arguments: `${ this.slot } ${ SLOT_TTL_S }`,
		};
		m[ LOCAL ] = true;
		return m;
	}

	// Record the slot acquired by the live SSE stream (from its `connected`
	// payload). The slot pool keys on (user, ip, slot) only.
	setSlot( slot ) {
		this.slot = slot;
	}

	// Forget the slot — the SSE stream closed, so there's nothing to refresh.
	clearSlot() {
		this.slot = null;
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
