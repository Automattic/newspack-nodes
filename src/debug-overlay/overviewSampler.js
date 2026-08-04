/**
 * The always-on Overview sampler: a single 5-second interval that drives
 * IoTelemetry.sample() so the overlay's rate charts have continuous history,
 * whether or not the panel is open or the Overview tab is selected. Started by
 * DebugOverlay while the debug overlay is enabled (`nodes-debug=1`).
 *
 * Ref-counted on a window singleton (like Core / IoTelemetry): a page can mount
 * more than one DebugOverlay (separate bundles), but they must share ONE
 * interval — double-sampling would corrupt the per-second rates. The interval
 * starts on the first start() and stops on the last balanced stop().
 *
 * One of the few pollers that does NOT ride the Router (`useRouterTick`): it is
 * always-on, independent of any graph, and its whole job is to keep sampling
 * when a graph is torn down or was never mounted. Riding the thing it measures
 * would blind it exactly when the history matters.
 */

import { IoTelemetry, SAMPLE_INTERVAL_MS } from '../runtime/io-telemetry';

const GLOBAL_KEY = '__newspackNodesOverviewSampler';

function store() {
	if ( ! window[ GLOBAL_KEY ] ) {
		window[ GLOBAL_KEY ] = { id: null, refs: 0 };
	}
	return window[ GLOBAL_KEY ];
}

/**
 * Take a reference on the shared sampler, starting the 5-second
 * `IoTelemetry.sample()` interval if this is the first caller. Every start
 * must be balanced by a `stopOverviewSampler()`, or the interval outlives
 * the overlay that wanted it.
 */
export function startOverviewSampler() {
	const s = store();
	s.refs += 1;
	if ( null === s.id ) {
		s.id = setInterval( () => IoTelemetry.sample(), SAMPLE_INTERVAL_MS );
	}
}

/**
 * Release one reference taken by `startOverviewSampler()`, clearing the
 * shared interval once the last holder lets go. Safe to call when no
 * reference is held: the refcount floors at zero rather than going negative.
 */
export function stopOverviewSampler() {
	const s = store();
	if ( s.refs > 0 ) {
		s.refs -= 1;
	}
	if ( 0 === s.refs && null !== s.id ) {
		clearInterval( s.id );
		s.id = null;
	}
}
