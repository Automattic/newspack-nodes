/**
 * runClockFast — run the substrate clock faster than the wall clock.
 *
 * A catalog polls on the CATALOG cadence, so its retry is half a minute away in
 * wall-clock terms. A test that watches the RETRY — a refused load recovering,
 * a saved topology appearing in the list — would otherwise have to wait it out.
 * The Router's real heartbeat still delivers each tick; each tick just reads a
 * minute of elapsed time.
 *
 * Every throttle in the runtime reads `Core.now()`, so this moves all of them
 * together. Call it from `beforeEach`, after `Core.reset()`.
 */

/* eslint-env jest */
import { Core } from '@newspack-nodes/runtime';

/** How many substrate seconds pass per real second. */
const DEFAULT_FACTOR = 60;

/**
 * @param {number} [factor] Substrate seconds per real second.
 * @return {void}
 */
export function runClockFast( factor = DEFAULT_FACTOR ) {
	const from = Date.now() / 1000;
	jest.spyOn( Core, 'now' ).mockImplementation(
		() => from + ( Date.now() / 1000 - from ) * factor
	);
}
