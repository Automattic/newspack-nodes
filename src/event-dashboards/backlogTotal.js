/**
 * Current fleet backlog for the SummaryCards "Backlog" card: the sum of each
 * reader's newest backlog (its byte distance behind the head of its source).
 *
 * Like the cache cards, NOT deduped by source — backlog is per-READER (each
 * consumer has its own position), so two readers of one source are two
 * distinct debts.
 */

/**
 * @param {?Object<string,{latest:{backlog:number}}>} consumers The `topicprobe:view` consumers map.
 * @return {number} Summed latest backlog in bytes (0 if none).
 */
export function backlogTotal( consumers ) {
	let total = 0;
	for ( const c of Object.values( consumers || {} ) ) {
		total += c.latest?.backlog || 0;
	}
	return total;
}
