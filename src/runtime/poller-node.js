/**
 * Poller — the self-timed verb poller, and the two console nodes built on it.
 *
 * One mechanism: ride the `_router` TIMER, mint the configured verb as a
 * command to `target`, and publish the reply as node state. `command()` stamps
 * FROM=name, so the reply comes back TO=FROM to this node's `fill()` — the
 * addressing IS the correlation, and nothing here correlates anything.
 *
 * A subclass writes only `publish()`: what the reply MEANS. `_dmesg` tallies a
 * stderr tail by level for the inspector's process-stats header; `_uptime`
 * trims the `up …` half for the canvas footer; the bare `Poller` publishes a
 * structured reply verbatim, which is what the Runtime and Profiler grids read.
 */

import { TimerNode } from './timer-node';
import { VALUE, payloadOf } from './message';

// Default cadence (ms) — slow; a poll reply is a whole tail or row list.
const POLL_INTERVAL_MS = 10000;

/**
 * Self-timed verb poller. `verb`, `pollArgs`, `pollIntervalMs` and `target` are
 * all settable by the mounting view, so one class serves `list_timers`,
 * `list_handles` and `list_profiles` as well as the named subclasses below.
 */
export class PollerNode extends TimerNode {
	/**
	 * Start with no verb and the default cadence; the mounting view sets both.
	 */
	constructor() {
		super();
		this.verb = '';
		this.pollArgs = [];
		this.pollIntervalMs = POLL_INTERVAL_MS;
	}

	/**
	 * Reply leg: unwrap the envelope once and hand the payload to `publish()`.
	 * A command response arrives as `{ name, arguments, payload }`, a
	 * bytestream arrives bare, and an envelope carrying no payload unwraps to
	 * undefined — never to the envelope itself.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		const value = message[ VALUE ];
		this.publish( payloadOf( value ) );
	}

	/**
	 * Router TIMER subscriber: emit the configured poll to `this.target`. A
	 * sinkless node, and a tick whose mint is refused, emit nothing and count
	 * nothing — `counter` is messages passed on.
	 */
	fire() {
		if ( ! this.sink ) {
			return;
		}
		const m = this.command( this.verb, this.pollArgs );
		if ( ! m ) {
			return; // unauthenticated; the next tick carries it
		}
		this.counter++;
		this.sink.fill( m );
	}

	/**
	 * What the reply means. The base publishes a STRUCTURED reply verbatim — a
	 * `-s` row list is what the Runtime and Profiler grids read. A text reply
	 * is dropped: a `profile on` ack landing here would otherwise blank the
	 * grid that the same node's row list feeds.
	 *
	 * @param {*} payload The unwrapped reply body.
	 */
	publish( payload ) {
		if ( ! payload || typeof payload !== 'object' ) {
			return;
		}
		this.setState( 'reply', payload );
	}

	/**
	 * Arm at this poller's own cadence. A caller may still pass an interval,
	 * which is how a view that owns the cadence sets it at the mount site.
	 *
	 * @param {?number} ms      Interval in ms; defaults to `pollIntervalMs`.
	 * @param {boolean} oneshot Disarm after the first fire.
	 */
	setTimer( ms = this.pollIntervalMs, oneshot = false ) {
		super.setTimer( ms, oneshot );
	}

	/**
	 * Console palette entry — hidden, takes no arguments, and accepts no
	 * user-routed fill (its only input is its own poll reply).
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Self-timed verb poller (configurable verb/args/target); publishes the reply as `reply`.',
			accepts_fill: false,
			arguments: [],
			commands: [],
			registrations: [ 'reply' ],
		};
	}
}
