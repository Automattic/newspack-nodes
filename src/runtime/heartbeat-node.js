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
import { Core } from './core';
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
const POKE_INTERVAL_S = 5;

export class HeartbeatNode extends TimerNode {
	constructor() {
		super();
		// The SSE slot to refresh + the partition it was acquired at; null until
		// the SSE stream connects (and cleared when it closes).
		this.slot = null;
		this.partition = -1;
		// Last emit time (s) — poke at most every POKE_INTERVAL_S.
		this.lastFired = 0;
	}

	// Consume the heartbeat reply; it carries no canvas state, so swallow it.
	fill( message ) {
		this.counter += 1;
		void message;
	}

	// Router TIMER subscriber (the _router calls fireCb -> fire): poke the slot at
	// most every POKE_INTERVAL_S, only while a worker stream slot is held (the poke
	// is meaningless without one).
	fire() {
		if ( null === this.slot || ! this.sink ) {
			return;
		}
		const now = Core.now();
		if ( now - this.lastFired < POKE_INTERVAL_S ) {
			return;
		}
		this.lastFired = now;
		this.counter += 1;
		this.sink.fill( this._pollMessage() );
	}

	// Record the slot acquired by the live SSE stream (from its `connected`
	// payload). `partition` is where the subscription resolved.
	setSlot( slot, partition ) {
		this.slot = slot;
		this.partition = partition;
	}

	// Forget the slot — the SSE stream closed, so there's nothing to refresh.
	clearSlot() {
		this.slot = null;
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
			arguments: `${ this.slot } ${ SLOT_TTL_S } ${ this.partition }`,
		};
		m[ LOCAL ] = true;
		return m;
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Pokes `workers/heartbeat` to refresh the SSE slot TTL.',
			arguments: [],
			commands: [],
		};
	}
}
