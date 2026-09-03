/**
 * Current fleet backlog for the SummaryCards "Backlog" card: the sum of every
 * LIVE reader's newest backlog, the bytes it sits behind the head of its source.
 *
 * Nothing is deduped by source, as in the cache cards. A backlog is per-READER
 * — each consumer owns its position — so two topologies tailing `firehose.p0`
 * are two distinct debts and both count.
 */

/**
 * Seconds a sample may age before it reads as history rather than as debt: the
 * five minutes `ProbeStreamViewNode` gives a key before eviction
 * (`ENTRY_TTL_MS`), so a reader leaves this card at the age it leaves the model.
 */
const FRESH_WINDOW_S = 300;

/**
 * Sum the newest backlog of every reader still reporting.
 *
 * Freshness is judged on the SAMPLE's own timestamp, not on when the view last
 * folded a record. `ProbeStreamViewNode` keeps a key alive by ARRIVAL time, and
 * the dashboard replays up to 24 hours of probe records at page load, so a
 * reader that died hours ago while behind enters the model freshly seen and
 * holds its final backlog until the TTL evicts it. Counting those samples puts
 * an hours-old debt no live reader is working off onto a card that reads as
 * current. The charts plot that history; this number must not.
 *
 * @param {?Object<string,{latest?:{ts?:number,backlog?:number}}>} consumers The `topicprobe:view` consumers map; a missing map counts as empty.
 * @param {number}                                                 [nowS]    Epoch seconds to judge freshness against; defaults to now.
 * @return {number} Summed newest backlog in bytes; 0 when no reader is fresh.
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
