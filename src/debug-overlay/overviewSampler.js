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
 */

import { IoTelemetry, SAMPLE_INTERVAL_MS } from '../runtime/io-telemetry';

const GLOBAL_KEY = '__newspackNodesOverviewSampler';

function store() {
	if ( ! window[ GLOBAL_KEY ] ) {
		window[ GLOBAL_KEY ] = { id: null, refs: 0 };
	}
	return window[ GLOBAL_KEY ];
}

// Start (or join) the shared sampler. Idempotent — the interval is created only
// on the first caller; later callers just take a reference.
export function startOverviewSampler() {
	const s = store();
	s.refs += 1;
	if ( null === s.id ) {
		s.id = setInterval( () => IoTelemetry.sample(), SAMPLE_INTERVAL_MS );
	}
}

// Release one reference; clear the interval once the last holder stops.
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
