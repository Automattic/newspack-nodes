/**
 * Per-(partition) process summary for a topology's worker rows. status/uptime/
 * heartbeat are process-level (one worker per topology+partition, identical
 * across its handler/source rows); restart_pending is OR'd across the rows.
 *
 * @param {Array} workers A topology's worker descriptors.
 * @return {Array} One summary per partition, sorted by partition.
 */
export function partitionSummaries( workers ) {
	const byPartition = new Map();
	( workers || [] ).forEach( ( wk ) => {
		const cur = byPartition.get( wk.partition );
		if ( ! cur ) {
			byPartition.set( wk.partition, {
				partition: wk.partition,
				status: wk.status,
				started_at: wk.started_at,
				heartbeat_age: wk.heartbeat_age,
				restart_pending: !! wk.restart_pending,
			} );
		} else if ( wk.restart_pending ) {
			cur.restart_pending = true;
		}
	} );
	return [ ...byPartition.values() ].sort(
		( a, b ) => a.partition - b.partition
	);
}
