/**
 * useAggregateRateSeries — derive fleet In/Out message-rate sparkline series from
 * the dump_metadata polls already feeding the graph. Each new `nodes` snapshot (a
 * poll) yields one sample: the delta of the aggregate source/sink counters since
 * the last poll, over elapsed time. The first reading only seeds the baseline —
 * a delta against a cold zero would turn the cumulative backfill into a bogus
 * spike (the reason `useGraphRates` stays "cold" for one sample). A counter going
 * backward (worker respawn) clamps to 0. `resetKey` drops the baseline + history
 * when the scope changes (e.g. switching to a different worker), so the new
 * scope's cumulative counters never delta against the prior scope's baseline.
 *
 * @param {Array}  nodes    The latest dump_metadata node list (`parsed.nodes`).
 * @param {string} resetKey Scope identity; a change clears the baseline + history.
 * @return {{ in: number[], out: number[], read: number[], write: number[] }}
 *   Trailing In/Out msg/s + bytes read/written per-second sample rings.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { processStats } from '../utils/processStats';

// ~1 minute of trailing samples at the ~1s metadata cadence.
const RATE_HISTORY_MAX = 60;

export function useAggregateRateSeries( nodes, resetKey ) {
	const [ series, setSeries ] = useState( {
		in: [],
		out: [],
		read: [],
		write: [],
	} );
	const prevRef = useRef( null );
	const keyRef = useRef( resetKey );

	useEffect( () => {
		// Scope changed: drop prior baseline+history (else totals-as-rates spike).
		if ( keyRef.current !== resetKey ) {
			keyRef.current = resetKey;
			prevRef.current = null;
			setSeries( { in: [], out: [], read: [], write: [] } );
		}
		const { messagesIn, messagesOut, bytesRead, bytesWritten } =
			processStats( nodes || [] );
		const prev = prevRef.current;
		// Wait for first reading WITH data to seed (else totals-as-rates spike).
		const hasData =
			messagesIn > 0 ||
			messagesOut > 0 ||
			bytesRead > 0 ||
			bytesWritten > 0;
		if ( ! prev && ! hasData ) {
			return;
		}
		const now = Date.now() / 1000;
		prevRef.current = {
			messagesIn,
			messagesOut,
			bytesRead,
			bytesWritten,
			ts: now,
		};
		if ( ! prev ) {
			return;
		}
		const dt = Math.max( 1, now - prev.ts );
		// Clamp a backward delta (worker respawn reset the cumulative counter) to 0.
		const rate = ( cur, was ) => Math.max( 0, ( cur - was ) / dt );
		const inRate = rate( messagesIn, prev.messagesIn );
		const outRate = rate( messagesOut, prev.messagesOut );
		const readRate = rate( bytesRead, prev.bytesRead );
		const writeRate = rate( bytesWritten, prev.bytesWritten );
		setSeries( ( s ) => ( {
			in: [ ...s.in, inRate ].slice( -RATE_HISTORY_MAX ),
			out: [ ...s.out, outRate ].slice( -RATE_HISTORY_MAX ),
			read: [ ...s.read, readRate ].slice( -RATE_HISTORY_MAX ),
			write: [ ...s.write, writeRate ].slice( -RATE_HISTORY_MAX ),
		} ) );
	}, [ nodes, resetKey ] );

	return series;
}
