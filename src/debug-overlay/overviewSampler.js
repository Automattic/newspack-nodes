/**
 * The always-on Overview sampler: one interval (`SAMPLE_INTERVAL_MS`, 5
 * seconds) driving `IoTelemetry.sample()`, so the overlay's rate charts carry
 * continuous history whether or not the panel is open or the Overview tab is
 * selected. `DebugOverlay` holds a reference for as long as `isDebugEnabled()`
 * says the overlay is on.
 *
 * Ref-counted on a window singleton, like Core and IoTelemetry: a page can
 * mount more than one DebugOverlay from separately built bundles, and they must
 * share ONE interval. Two would append two rows per cadence into a fixed-size
 * ring, halving the wall-clock span the persisted chart covers. The interval
 * starts on the first `startOverviewSampler()` and stops on the last balanced
 * `stopOverviewSampler()`.
 *
 * One of the few pollers that does NOT ride the Router (`useRouterTick`): it is
 * always-on, independent of any graph, and its whole job is to keep sampling
 * when a graph is torn down or was never mounted. Riding the thing it measures
 * would blind it exactly when the history matters.
 */

import { IoTelemetry, SAMPLE_INTERVAL_MS } from '../runtime/io-telemetry';

/**
 * Window property holding the shared `{ id, refs }` record. The window is the
 * sharing surface because every consumer bundle inlines its own copy of this
 * module, so a module-level record would give each copy an interval of its own
 * — the same reason IoTelemetry parks its accumulator there.
 */
const GLOBAL_KEY = '__newspackNodesOverviewSampler';

/**
 * Read the shared sampler record, creating it when the window holds none.
 * Every call re-checks the window rather than caching the object here, so
 * deleting the property — how the unit test resets between cases — yields a
 * clean record instead of a stale one this module still points at.
 *
 * @return {{ id: ?ReturnType<typeof setInterval>, refs: number }} The opaque
 *   interval handle `clearInterval()` takes back, null while stopped, and the
 *   count of live references.
 */
function store() {
	if ( ! window[ GLOBAL_KEY ] ) {
		window[ GLOBAL_KEY ] = { id: null, refs: 0 };
	}
	return window[ GLOBAL_KEY ];
}

/**
 * Take a reference on the shared sampler, starting the `IoTelemetry.sample()`
 * interval if this is the first caller. Every start must be balanced by a
 * `stopOverviewSampler()`, or the interval outlives the overlay that wanted it.
 *
 * @return {void}
 */
export function startOverviewSampler() {
	const s = store();
	s.refs += 1;
	if ( null === s.id ) {
		s.id = setInterval( () => IoTelemetry.sample(), SAMPLE_INTERVAL_MS );
	}
}

/**
 * Release one reference taken by `startOverviewSampler()`, clearing the shared
 * interval once the last holder lets go. Safe to call when no reference is
 * held: the count floors at zero, where a count left negative would carry into
 * the next start and leave its interval running with nobody holding it.
 *
 * @return {void}
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
