/**
 * steppedClock — the substrate clock held still, and Router ticks the test
 * runs itself, so a poll that retries on a 30-second cadence is exercised in
 * one step instead of waited out.
 *
 * `Core.now()` reads the value the test sets, which every decision taken
 * against it follows: TimerNode's grid gate (ADR-17), FetcherNode's
 * `retry_after_s` window, and the command session's expiry and `/auth`
 * backoff. The Router's own cadence is held (`holdRouterCadence()`), so
 * nothing ticks behind the test's back; `tick( seconds )` moves the clock on
 * and runs the one tick the cadence would have run then.
 *
 * Call it from `beforeEach`, after `Core.reset()`.
 */

/* eslint-env jest */
import { act } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';
import { holdRouterCadence } from './holdRouterCadence';

/**
 * Freeze `Core.now()` at `start` and hold the Router's cadence.
 *
 * @param {number} [start] Seconds the clock starts at.
 * @return {{tick: (seconds: number) => Promise<void>}} Moves the clock on by
 *   `seconds` and runs one Router tick, inside `act`.
 */
export function steppedClock( start = 1_790_000_500.5 ) {
	let now = start;
	jest.spyOn( Core, 'now' ).mockImplementation( () => now );
	const router = holdRouterCadence();
	return {
		tick: ( seconds ) =>
			act( async () => {
				now += seconds;
				router.fireCb();
			} ),
	};
}
