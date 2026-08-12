/**
 * Current fleet backlog for the SummaryCards "Backlog" card: the sum of each
 * LIVE reader's newest backlog (its byte distance behind the head of its source).
 *
 * Like the cache cards, NOT deduped by source — backlog is per-READER (each
 * consumer has its own position), so two readers of one source are two
 * distinct debts.
 */

// Older than this is history, not a debt (the probe stream's own TTL).
const FRESH_WINDOW_S = 300;

/**
 * Sum the backlog of every reader still reporting.
 *
 * Staleness is judged on the SAMPLE's own timestamp, not on when the view last
 * folded a record. The consumers map keeps an entry alive by INGEST time, and
 * the dashboard replays 24h of probe records at page load — so a reader that
 * died while behind is re-stamped as freshly seen and carries its final backlog
 * forever. Three readers dead 17 hours reported 528 MB of debt while
 * `wp nodes status` showed every live reader 0B behind. The charts still plot
 * that history; a "current" card must not add it up.
 *
 * @param {?Object<string,{latest:{ts?:number,backlog:number}}>} consumers The `topicprobe:view` consumers map.
 * @param {number}                                               [nowS]    Epoch seconds to judge freshness against; defaults to now.
 * @return {number} Summed latest backlog in bytes (0 if none).
 */
export function backlogTotal( consumers, nowS = Date.now() / 1000 ) {
	let total = 0;
	for ( const c of Object.values( consumers || {} ) ) {
		const latest = c.latest;
		if ( ! latest ) {
			continue;
		}
		// A probe that reports no ts is taken at its word rather than dropped.
		const ts = latest.ts;
		if ( 'number' === typeof ts && nowS - ts > FRESH_WINDOW_S ) {
			continue;
		}
		total += latest.backlog || 0;
	}
	return total;
}
