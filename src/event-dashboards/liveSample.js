/**
 * The one freshness rule every live SummaryCards card applies to a reader's
 * `latest` probe sample: "Messages/s", "Backlog" and "Total Cache".
 *
 * A live card shows the fleet as of the newest message seen, so a sample counts
 * only while it is within a minute of the stream head: the newest `latest.ts`
 * across the readers. The `topicprobe:view` model keeps every reader's 24h
 * series for the charts and the 24h cards, which is why a reader that stopped
 * hours ago is still in the map: its final sample — often a catch-up burst —
 * must not read as current.
 *
 * Every stamp comes from the workers' clock, so judging against the head rather
 * than the browser's clock leaves no skew to allow for. A fleet gone silent
 * keeps its last head, and with it the readers fresh relative to that head.
 */

/** Seconds a probe sample stays current, four 15-second probe sweeps. */
export const LIVE_WINDOW_S = 60;

/**
 * The stream head: the newest sample timestamp any reader in the map reports.
 *
 * @param {?Object<string,{latest?:{ts?:number}}>} consumers The `topicprobe:view` consumers map; a missing map counts as empty.
 * @return {number} Epoch seconds of the newest dated sample; -Infinity when none is dated.
 */
export function streamHead( consumers ) {
	let head = -Infinity;
	for ( const c of Object.values( consumers || {} ) ) {
		const ts = c.latest?.ts;
		if ( 'number' === typeof ts && ts > head ) {
			head = ts;
		}
	}
	return head;
}

/**
 * Whether a reader counts toward a live card: it names the source the charts
 * plot it under, and its newest sample is live.
 *
 * @param {{source?:string,latest?:{ts?:number}}} c     A `topicprobe:view` consumer.
 * @param {number}                                headS The stream head, from `streamHead()`.
 * @return {boolean} True when the card counts it.
 */
export function isLiveReader( c, headS ) {
	return Boolean( c.source ) && isLiveSample( c.latest, headS );
}

/**
 * Whether a probe sample is current enough for a live card to count.
 *
 * A sample with no numeric `ts` never counts: a live card cannot show what it
 * cannot date.
 *
 * @param {?{ts?:number}} sample A reader's `latest` probe sample.
 * @param {number}        headS  The stream head, from `streamHead()`.
 * @return {boolean} True when the sample is at most LIVE_WINDOW_S behind the head.
 */
export function isLiveSample( sample, headS ) {
	const ts = sample?.ts;
	return 'number' === typeof ts && headS - ts <= LIVE_WINDOW_S;
}
