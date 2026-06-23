import { useEffect, useMemo, useState } from '@wordpress/element';
import { IoTelemetry } from '../runtime/io-telemetry';
import { overviewChartSeries, currentRates } from './overviewChartSeries';

/**
 * Live read of the overlay's I/O telemetry for the Overview tab: cumulative
 * totals, the latest per-second rates, and the two In/Out chart series. Re-reads
 * (and re-renders) whenever the always-on sampler emits a new rate row — i.e.
 * once every sample tick, NOT on every record() — keeping the cards/charts in
 * step with the persisted series rather than thrashing on raw traffic.
 *
 * @return {{ totals: Object, rates: Object, msgRateSeries: Object, byteRateSeries: Object }}
 *   Cumulative totals, current rates, and the Message/Byte rate chart series.
 */
export function useOverviewStats() {
	const [ , force ] = useState( 0 );
	useEffect(
		() => IoTelemetry.subscribe( () => force( ( n ) => n + 1 ) ),
		[]
	);

	const totals = IoTelemetry.snapshot();
	const ring = IoTelemetry.getSeries();
	const rates = currentRates( ring );
	// The ring is mutated in place, so key the memo on the monotonic emitted-sample
	// revision: the charts get a fresh, stable-identity series exactly once per new
	// sample (and skip otherwise, so the memoized TopicsChart doesn't redraw).
	const { msgRate, byteRate } = useMemo(
		() => overviewChartSeries( ring ),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ IoTelemetry.revision ]
	);

	return {
		totals,
		rates,
		msgRateSeries: msgRate,
		byteRateSeries: byteRate,
	};
}
