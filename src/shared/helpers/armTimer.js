import names from '../../runtime/reserved-node-names.json';
import { hasSession } from '../../runtime/command-auth';

/** @typedef {import('../../runtime/timer-node').TimerNode} TimerNode */

/**
 * Fire a hitchhiking Timer now: mark it due and ask the Router for a tick,
 * which fires it inside that tick's lock and flush, so whatever it mints
 * rides the one batched POST. Asks coalesce, so many in one commit are one
 * tick.
 *
 * @param {TimerNode} timer The Timer to fire.
 * @return {void}
 */
export function pollTimerNow( timer ) {
	timer.markDue();
	timer.registry.node( names.ROUTER )?.requestTick();
}

/**
 * Arm a Timer, and fire it at once when that arms a disarmed hitchhiker.
 *
 * A poller resumed by a shown tab, an unpause or an enable has been silent,
 * so its data is stale the moment it is seen; waiting for its next grid
 * boundary would leave it stale for up to a whole interval. An armed timer
 * re-armed at a new cadence stays on its grid (ADR-17), and a sub-second
 * timer on a slot of its own fires at its interval anyway.
 *
 * @param {TimerNode} timer      The Timer to arm.
 * @param {?number}   intervalMs Cadence in ms; null takes the Router's own.
 * @return {void}
 */
export function armTimer( timer, intervalMs ) {
	const resuming = 'inactive' === timer.mode;
	timer.setTimer( intervalMs );
	if ( resuming && 'router' === timer.mode ) {
		pollTimerNow( timer );
	}
}

/**
 * The FIRE listener id `keepUnsignedDue()` registers under, so registering it
 * twice on one Timer replaces the first rather than adding a second.
 */
const UNSIGNED_LISTENER = 'keepUnsignedDue';

/**
 * Keep a Timer due after a tick it fired with no command session.
 *
 * Such a tick mints nothing — a Fetcher behind it parks its ask — so the poll
 * is still owed. Due, the Timer fires on the tick a landing session asks for,
 * whatever its throttle or grid say, and that tick sends what was parked. Call
 * it once on every Timer whose tick reaches a Fetcher; a Poller or Heartbeat
 * mints itself and marks itself due instead.
 *
 * @param {TimerNode} timer The Timer driving the Fetchers.
 * @return {void}
 */
export function keepUnsignedDue( timer ) {
	timer.register( 'FIRE', UNSIGNED_LISTENER, () => {
		if ( ! hasSession() ) {
			timer.markDue();
		}
	} );
}
