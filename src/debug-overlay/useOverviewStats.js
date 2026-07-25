import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { IoTelemetry } from '../runtime/io-telemetry';
import { overviewChartSeries } from './overviewChartSeries';
import { RateSmoother } from '../shared/rateSmoother';

// Card refresh cadence (20Hz); live rate uses the RateSmoother (10s avg, EMA).
const TICK_MS = 50;

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
				// Counter went backward = telemetry reset; drop windows to 0.
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
