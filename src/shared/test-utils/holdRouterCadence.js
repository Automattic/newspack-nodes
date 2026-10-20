/**
 * holdRouterCadence — stand the page's Router up with its own cadence stopped,
 * so a test on the real clock ticks only when it asks.
 *
 * The Router ticks just after each boundary of the wall-clock grid, so a test
 * that runs across one sees a tick it never asked for: an extra POST, or a
 * timer firing a second time. `mountExospine()` adopts a Router already
 * standing as it is, never re-arming it, so one built and stopped before the
 * first mount stays stopped. The test then ticks through a mount's first load,
 * `pollNow()`, a landing session, or `Core.node( ROUTER ).fireCb()`.
 *
 * Call it from `beforeEach`, after `Core.reset()`.
 */

import { RouterNode, ROUTER_TICK_MS } from '../../runtime/router-node';
import names from '../../runtime/reserved-node-names.json';

/**
 * Name a stopped Router, keeping the tick's cadence a hitchhiker reads.
 *
 * @return {RouterNode} The held Router.
 */
export function holdRouterCadence() {
	const router = new RouterNode();
	router.name = names.ROUTER;
	router.stopTimer();
	// stopTimer zeroes it; a bare setTimer() inherits it.
	router.interval_ms = ROUTER_TICK_MS;
	return router;
}
