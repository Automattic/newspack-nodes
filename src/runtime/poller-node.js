/**
 * Poller — the self-timed verb poller every console readout is built on.
 *
 * One mechanism: ride the `_router` TIMER, mint the configured verb as a
 * command to `target`, and publish the reply into a node field. FROM is the
 * node's name, with its `subject` appended as one escaped segment when it asks
 * about one (`replyAddress()`), so the reply comes back TO=FROM to this node's
 * `fill()` naming what it answers (ADR-7) — the addressing IS the correlation,
 * and nothing here correlates anything.
 *
 * A subclass supplies `publish()`: what the reply MEANS. `DmesgNode` tallies a
 * stderr tail by level for the inspector's process-stats header, `UptimeNode`
 * trims the `up …` half for the canvas footer, and each lives in its own file.
 * The bare `Poller` publishes a structured reply verbatim, which is what the
 * Runtime and Profiler grids read.
 */

import { ReactBridge } from './react-bridge';
import { TimerNode } from './timer-node';
import { FROM, VALUE, payloadOf } from './message';
import { replyAddress, replySubject } from './reply-subject';

/**
 * Default cadence in milliseconds, deliberately slow: a poll reply carries a
 * whole tail or row list rather than a delta, so asking twice as often buys
 * the same rows twice.
 */
const POLL_INTERVAL_MS = 10000;

/**
 * The cadence of a readout someone is WATCHING — a console modal, the uptime
 * clock, a small graph's metadata. A viewed worker's SSE stream idles out
 * after `sse_idle_timeout` (5s), so anything slower lets it close between
 * replies. A harmonic of the shared 10s grid (ADR-17), so these polls still
 * meet the slower ones on a tick and leave in their POST.
 */
export const LIVE_POLL_INTERVAL_MS = 2000;

/**
 * Self-timed verb poller. `verb`, `pollArgs`, `pollIntervalMs` and `target`
 * are all set by the mounting view, so one class serves `list_timers`,
 * `list_handles` and `list_profiles` with no subclass for any of them.
 *
 * A cadence of 1000ms or more hitchhikes the `_router` TIMER, which puts every
 * poller on the page on one shared wall-clock grid (ADR-17): harmonic cadences
 * meet on the same tick and leave in a single batched POST, where a
 * `setInterval` of each poller's own would drift into a request apiece.
 */
export class PollerNode extends ReactBridge( TimerNode ) {
	/** The last reply: a whole timer, handle or profile table, too long to print. */
	static dumpOmits = [ 'reply' ];

	/**
	 * Start with no verb, no arguments and the default cadence. The mounting
	 * view sets the verb it asks, the arguments it passes and the target it
	 * asks them of.
	 */
	constructor() {
		super();
		this.verb = '';
		/** @type {string[]} */
		this.pollArgs = [];
		this.pollIntervalMs = POLL_INTERVAL_MS;
		/**
		 * What the poll asks about, ridden on FROM as one encoded segment so
		 * the reply comes back naming it; null rides none.
		 *
		 * @type {?string}
		 */
		this.subject = null;
		/**
		 * The last structured reply, null before the first.
		 *
		 * @type {?Object|?Array}
		 */
		this.reply = null;
	}

	/**
	 * Reply leg: unwrap the envelope once and hand the payload to `publish()`.
	 * A command response arrives as `{ name, arguments, payload }`, a
	 * bytestream arrives bare, and an envelope carrying no payload unwraps to
	 * null — never to the envelope itself, which `publish()` would take for a
	 * result and publish over the last good one.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		if ( this.answersSubject( message ) ) {
			this.publish( payloadOf( message[ VALUE ] ) );
		}
	}

	/**
	 * One tick: mint the configured poll and emit it to `this.target`. A
	 * mounting view wanting its first reading now marks the poller due and
	 * asks the Router for a tick (`armTimer()`), so it rides that tick's POST;
	 * a reload may call it directly, as the topology catalog's does.
	 *
	 * A sinkless node, and a tick whose mint is refused, emit nothing and
	 * count nothing — `counter` is messages passed on.
	 */
	fire() {
		if ( ! this.sink ) {
			return;
		}
		const m = this.command( this.verb, this.pollArgs );
		if ( ! m ) {
			// @longform Still due: `fireCb` records this fire before calling
			// here, and a tick that sent NOTHING must not spend it. The tick
			// that lands mid-auth is the first one on every cold page load,
			// so spending it would put the first poll a whole period out —
			// ten seconds before the console could read the topology catalog
			// its include hulls come from.
			this.markDue();
			return; // unauthenticated; the next tick carries it
		}
		m[ FROM ] = replyAddress( this.name, this.subject );
		this.counter++;
		this.sink.fill( m );
	}

	/**
	 * Whether a reply answers the subject asked about now: the Router leaves
	 * the subject a poll rode on FROM as the reply's remaining TO, so a late
	 * answer about a subject since replaced names that one and is dropped.
	 *
	 * @param {Array} message The reply as it reached this node.
	 * @return {boolean} True when it may publish.
	 */
	answersSubject( message ) {
		return (
			null === this.subject || replySubject( message ) === this.subject
		);
	}

	/**
	 * What the reply MEANS, and the one method a subclass supplies. The base
	 * publishes a STRUCTURED reply verbatim — a `-s` row list is what the
	 * Runtime and Profiler grids read. A text reply is dropped: a `profile on`
	 * ack landing here would otherwise blank the grid that the same node's row
	 * list feeds.
	 *
	 * @param {*} payload The unwrapped reply body.
	 */
	publish( payload ) {
		if ( ! payload || typeof payload !== 'object' ) {
			return;
		}
		this.setField( 'reply', payload );
	}

	/**
	 * Arm at this poller's own cadence. Bare, `TimerNode.setTimer()` takes the
	 * Router's 1s tick and throttles nothing, so defaulting the interval to
	 * `pollIntervalMs` is what makes a bare call at the mount site mean the
	 * cadence this node already carries. A caller may still pass one, which is
	 * how a view that owns the cadence sets it there instead.
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
