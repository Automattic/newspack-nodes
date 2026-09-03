import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { IoTelemetry } from '../runtime/io-telemetry';
import { overviewChartSeries } from './overviewChartSeries';
import { RateSmoother } from '../shared/rateSmoother';

/**
 * Card refresh cadence (20Hz). The live rate on those cards is a RateSmoother
 * reading (10s window, EMA), because a raw 50ms delta reads as a burst or a
 * zero and never as a rate.
 *
 * Its own interval rather than a `useRouterTick` Timer, for the reason the 5s
 * sampler keeps one: the Overview measures the page graph's own traffic, and a
 * Router-borne timer is torn down with the graph it measures, including across
 * a Console graph rebuild. The overlay also runs on pages that mount no graph
 * at all, where such a Timer never arms.
 */
const TICK_MS = 50;

/**
 * Live read of the overlay's I/O telemetry for the Overview tab. The cards
 * (totals plus a live rate) refresh at 20Hz off the raw counters; the two
 * In/Out CHARTS stay on the 5-second sampled series, re-rendered once per
 * sample tick, so the fast card refresh never thrashes the chart redraw.
 *
 * @return {{totals:Object,rates:{byteIn:number,byteOut:number,msgIn:number,msgOut:number},msgRateSeries:Object<string,Object>,byteRateSeries:Object<string,Object>}}
 *   The whole `IoTelemetry.snapshot()` — cumulative counters, the SSE connect
 *   stamp and the classified message ring — the smoothed per-second In/Out
 *   rates, and the Message/Byte chart panels, each keyed `In` and `Out`.
 */
export function useOverviewStats() {
	// Re-render trigger; the values themselves are read from refs at render.
	const [ , force ] = useState( 0 );
	const ratesRef = useRef( { byteIn: 0, byteOut: 0, msgIn: 0, msgOut: 0 } );
	// One RateSmoother per stream + the last counter snapshot to delta against.
	const smoothersRef = useRef( {
		byteIn: new RateSmoother(),
		byteOut: new RateSmoother(),
		msgIn: new RateSmoother(),
		msgOut: new RateSmoother(),
	} );
	const prevRef = useRef( null );

	// 5s sampler notify re-renders so the revision-keyed chart memo updates.
	useEffect(
		() => IoTelemetry.subscribe( () => force( ( n ) => n + 1 ) ),
		[]
	);

	// 20Hz tick: feed each counter delta to its RateSmoother, then re-render.
	useEffect( () => {
		const tick = () => {
			const s = IoTelemetry.snapshot();
			const now = Date.now();
			const prev = prevRef.current;
			const sm = smoothersRef.current;
			if ( prev ) {
				// Backward counter = a reset; drop the stale 10s windows.
				if ( s.bytesIn < prev.bytesIn || s.msgsIn < prev.msgsIn ) {
					sm.byteIn.reset();
					sm.byteOut.reset();
					sm.msgIn.reset();
					sm.msgOut.reset();
				}
				ratesRef.current = {
					byteIn: sm.byteIn.add( s.bytesIn - prev.bytesIn, now ),
					byteOut: sm.byteOut.add( s.bytesOut - prev.bytesOut, now ),
					msgIn: sm.msgIn.add( s.msgsIn - prev.msgsIn, now ),
					msgOut: sm.msgOut.add( s.msgsOut - prev.msgsOut, now ),
				};
			}
			prevRef.current = {
				bytesIn: s.bytesIn,
				bytesOut: s.bytesOut,
				msgsIn: s.msgsIn,
				msgsOut: s.msgsOut,
			};
			force( ( n ) => n + 1 );
		};
		const id = setInterval( tick, TICK_MS );
		return () => clearInterval( id );
	}, [] );

	const totals = IoTelemetry.snapshot();
	const ring = IoTelemetry.getSeries();
	// Ring mutated in place; memo keyed on the sample revision (per sample).
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
