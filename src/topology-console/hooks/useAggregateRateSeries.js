/**
 * useAggregateRateSeries — derive fleet In/Out message-rate sparkline series from
 * the dump_metadata polls already feeding the graph. Each new `nodes` snapshot (a
 * poll) yields one sample: the delta of the aggregate source/sink counters since
 * the last poll, over elapsed time. The first reading only seeds the baseline —
 * a delta against a cold zero would turn the cumulative backfill into a bogus
 * spike (the reason `useGraphRates` stays "cold" for one sample). A counter going
 * backward (worker respawn) clamps to 0.
 *
 * @param {Array} nodes The latest dump_metadata node list (`parsed.nodes`).
 * @return {{ in: number[], out: number[] }} Trailing In/Out msg/s sample rings.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { processStats } from '../utils/processStats';

// ~1 minute of trailing samples at the ~1s metadata cadence.
const RATE_HISTORY_MAX = 60;

export function useAggregateRateSeries( nodes ) {
	const [ series, setSeries ] = useState( { in: [], out: [] } );
	const prevRef = useRef( null );

	useEffect( () => {
		const { messagesIn, messagesOut } = processStats( nodes );
		const now = Date.now() / 1000;
		const prev = prevRef.current;
		prevRef.current = { messagesIn, messagesOut, ts: now };
		if ( ! prev ) {
			return;
		}
		const dt = Math.max( 1, now - prev.ts );
		const inRate = Math.max( 0, ( messagesIn - prev.messagesIn ) / dt );
		const outRate = Math.max( 0, ( messagesOut - prev.messagesOut ) / dt );
		setSeries( ( s ) => ( {
			in: [ ...s.in, inRate ].slice( -RATE_HISTORY_MAX ),
			out: [ ...s.out, outRate ].slice( -RATE_HISTORY_MAX ),
		} ) );
	}, [ nodes ] );

	return series;
}
