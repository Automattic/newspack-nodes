/**
 * The one per-partition fold over a topology's worker rows, shared by
 * `TopologyRow`'s badges, `fleetSummary`'s running count and
 * `useTopologyManager`'s health derivation.
 *
 * `reconstructWorkers` emits one row per handler a consumer feeds, per
 * partition, so a consumer fanning through a Tee to three processors
 * contributes three rows describing ONE worker process. Counting rows reports
 * a single-partition topology as three workers. Every consumer therefore needs
 * this fold, and a fourth hand-rolled copy of it is how they drift apart.
 */

/**
 * One worker process, as the dashboards read it.
 *
 * @typedef {Object} PartitionSummary
 * @property {number}  partition       Partition index the process owns.
 * @property {string}  state           `live`, `stale`, `held`, `idle` or `down`, as `wp nodes status` reads the slot.
 * @property {?number} started_at      Epoch seconds the process started; null when the lock dir records no start.
 * @property {?number} heartbeat_age   Seconds since the last heartbeat; null when none was ever written.
 * @property {boolean} restart_pending A restart is queued on the partition's lock dir.
 */

/**
 * Reduce a topology's worker rows to one summary per partition.
 *
 * The first row of a partition supplies the process fields, because every row
 * of a partition reads the same lock dir: `state`, `started_at` and
 * `heartbeat_age` are identical across them. `restart_pending` folds with OR
 * instead, so a flag on any row survives.
 *
 * `state` rides through as the server's verdict. The server judges each
 * heartbeat against the topology's OWN declared `stale_timeout`, which the
 * job pools raise to 600s, so a threshold applied here would call a live
 * job-worker stalled and contradict `wp nodes status` reading that same
 * heartbeat.
 *
 * @param {?Array<PartitionSummary>} workers A topology's worker rows, each
 *                                           carrying these fields plus its own
 *                                           handler, source and probe state.
 *                                           Null summarizes as no partitions.
 * @return {Array<PartitionSummary>} One summary per partition, ordered by
 *   partition number rather than by the order the rows arrived in.
 */
export function partitionSummaries( workers ) {
	const byPartition = new Map();
	( workers || [] ).forEach( ( wk ) => {
		const cur = byPartition.get( wk.partition );
		if ( ! cur ) {
			byPartition.set( wk.partition, {
				partition: wk.partition,
				// The server's verdict, never re-derived from a hardcoded age.
				state: wk.state,
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
