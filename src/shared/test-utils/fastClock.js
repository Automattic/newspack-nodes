/**
 * runClockFast — run the substrate clock faster than the wall clock, so a test
 * reaches the next poll boundary instead of waiting it out.
 *
 * A catalog polls every 30 seconds and that poll IS its retry, so a test that
 * watches the RETRY — a refused load recovering, a saved topology appearing in
 * the list — would otherwise sit through half a minute. The Router's real 1s
 * heartbeat still delivers each tick; each tick just reads a minute of elapsed
 * time, so the first one already lands past the boundary.
 *
 * One mock moves every decision taken against `Core.now()` together, and a poll
 * test crosses two of them: TimerNode's wall-clock grid gate (ADR-17) and
 * FetcherNode's `retry_after_s` window. Whatever reads the wall clock directly
 * keeps real time — SseInNode's reconnect watchdog and the command signer's
 * expiry are the two that matter.
 *
 * Call it from `beforeEach`, after `Core.reset()`. Each call rebases on the
 * real clock, so the accelerated offset restarts with every test rather than
 * compounding across the file.
 */

/* eslint-env jest */
import { Core } from '@newspack-nodes/runtime';

/**
 * How many substrate seconds pass per real second. At 60 the 30-second catalog
 * boundary falls inside the first 1s Router tick, so a retry costs a tick or
 * two of real time.
 */
const DEFAULT_FACTOR = 60;

/**
 * Shadow `Core.now()` with a clock rebased on the real one and running faster.
 *
 * @param {number} [factor] Substrate seconds per real second.
 * @return {void}
 */
export function runClockFast( factor = DEFAULT_FACTOR ) {
	const from = Date.now() / 1000;
	jest.spyOn( Core, 'now' ).mockImplementation(
		() => from + ( Date.now() / 1000 - from ) * factor
	);
}
