import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { IoTelemetry } from '../runtime/io-telemetry';
import { overviewChartSeries } from './overviewChartSeries';

// Card refresh cadence (20Hz) and the sliding window the live rate is measured
// over. The window smooths the per-tick rate so it reads steady, not spiky.
const TICK_MS = 50;
const RATE_WINDOW_S = 1;

/**
 * Live read of the overlay's I/O telemetry for the Overview tab. The cards
 * (totals + a live rate) refresh at 20Hz off the raw counters; the two In/Out
 * CHARTS stay on the 5-second sampled series (re-rendered once per sample tick),
 * so the fast card refresh never thrashes the chart redraw.
 *
 * @return {{ totals: Object, rates: Object, msgRateSeries: Object, byteRateSeries: Object }}
 *   Cumulative totals, the live In/Out rates, and the Message/Byte chart series.
 */
export function useOverviewStats() {
	const [ , force ] = useState( 0 );
	const ratesRef = useRef( { byteIn: 0, byteOut: 0, msgIn: 0, msgOut: 0 } );
	const windowRef = useRef( [] );

	// The 5s sampler notify re-renders so the revision-keyed chart memo updates.
	useEffect(
		() => IoTelemetry.subscribe( () => force( ( n ) => n + 1 ) ),
		[]
	);

	// 20Hz tick: recompute the live In/Out rate over a 1s sliding window of the
	// raw counters, then re-render so the cards (totals read below + this rate)
	// stay current. The charts are untouched — they key off the sample revision.
	useEffect( () => {
		const tick = () => {
			const s = IoTelemetry.snapshot();
			const t = Date.now() / 1000;
			const buf = windowRef.current;
			buf.push( {
				t,
				bytesIn: s.bytesIn,
				bytesOut: s.bytesOut,
				msgsIn: s.msgsIn,
				msgsOut: s.msgsOut,
			} );
			// Keep the window to RATE_WINDOW_S, but always keep >= 2 points so a
			// brand-new window can still measure a delta.
			while ( buf.length > 2 && t - buf[ 0 ].t > RATE_WINDOW_S ) {
				buf.shift();
			}
			const oldest = buf[ 0 ];
			const dt = t - oldest.t;
			if ( dt > 0 ) {
				const rate = ( a, b ) => Math.max( 0, ( a - b ) / dt );
				ratesRef.current = {
					byteIn: rate( s.bytesIn, oldest.bytesIn ),
					byteOut: rate( s.bytesOut, oldest.bytesOut ),
					msgIn: rate( s.msgsIn, oldest.msgsIn ),
					msgOut: rate( s.msgsOut, oldest.msgsOut ),
				};
			}
			force( ( n ) => n + 1 );
		};
		const id = setInterval( tick, TICK_MS );
		return () => clearInterval( id );
	}, [] );

	const totals = IoTelemetry.snapshot();
	const ring = IoTelemetry.getSeries();
	// The ring is mutated in place, so key the memo on the monotonic emitted-sample
	// revision: the charts get a fresh, stable-identity series exactly once per new
	// sample (and skip otherwise, so the memoized TopicsChart doesn't redraw — even
	// as the cards re-render at 20Hz).
	const { msgRate, byteRate } = useMemo(
		() => overviewChartSeries( ring ),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ IoTelemetry.revision ]
	);

	return {
		totals,
		rates: ratesRef.current,
		msgRateSeries: msgRate,
		byteRateSeries: byteRate,
	};
}
