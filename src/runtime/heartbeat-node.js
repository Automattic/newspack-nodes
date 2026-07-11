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

// Slot TTL (s) per poke; throttle is half the TTL so a missed tick survives.
const SLOT_TTL_S = 10;
const POKE_INTERVAL_MS = 5000;

export class HeartbeatNode extends TimerNode {
	constructor() {
		super();
		// SSE slot to refresh; null until stream connects, cleared on close.
		this.slot = null;
	}

	// Consume the heartbeat reply; it carries no canvas state, so swallow it.
	fill( message ) {
		this.counter++;
		void message;
	}

	// Router TIMER subscriber: fire() pokes the slot, only while one is held.
	fire() {
		if ( null === this.slot || ! this.sink ) {
			return;
		}
		this.counter++;
		this.sink.fill( this._pollMessage() );
	}

	// Poke TM_COMMAND to this.target; FROM=name reply path, LOCAL authorizes.
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

	// Record the slot the live SSE stream acquired; holding one arms the poke.
	setSlot( slot ) {
		this.slot = slot;
		this.setTimer( POKE_INTERVAL_MS );
	}

	// Forget the slot and stop poking — the SSE stream closed.
	clearSlot() {
		this.slot = null;
		this.stopTimer();
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
