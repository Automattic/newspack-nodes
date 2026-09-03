/**
 * Roll the topology rows up into the fleet vitals SummaryCards renders on the
 * Overview and Topologies tabs: topology and active counts, worker-process
 * liveness, and the worst health across the active topologies.
 *
 * Worker liveness counts against each active topology's CONFIGURED
 * `num_partitions`, never the partitions that happened to report a worker in
 * the last snapshot — that reads "1 / 1" straight through an outage instead of
 * "1 / 2". The running side folds through `partitionSummaries()`, the fold
 * TopologyRow and useTopologyManager share, so it counts worker PROCESSES
 * rather than the several rows each process contributes.
 */

import { partitionSummaries } from './partitionSummaries';

/**
 * Health levels ranked worst to best, so rolling the fleet up is taking a
 * minimum. A level missing from the table ranks as `ok`: an unrecognized
 * health string must not darken the card.
 *
 * @type {Object<string,number>}
 */
const HEALTH_RANK = { stalled: 0, behind: 1, ok: 2 };

/**
 * Fold the topology rows into the fleet vitals.
 *
 * Only active topologies contribute workers and health, so a stopped topology
 * frozen at `stalled` never drags the health card down. A topology carrying no
 * `num_partitions` expects one worker. `workersUp` is capped per topology at
 * that expected count, so processes still running on partitions a lowered
 * `num_partitions` no longer covers cannot make the card read "3 / 2".
 *
 * @param {?Array<Object>} topologies Rows from useTopologyManager: `active`,
 *                                    `num_partitions`, `health` and an
 *                                    optional live `status.workers`. Null
 *                                    summarizes as an empty fleet.
 * @return {{ topologyCount: number, activeCount: number, workersUp: number,
 *   workersTotal: number, health: string, behindCount: number,
 *   stalledCount: number }} Fleet vitals. `health` is the worst of the active
 *   topologies; `behindCount` and `stalledCount` count the active topologies
 *   at each of those two levels.
 */
export function fleetSummary( topologies ) {
	const list = topologies || [];
	const actives = list.filter( ( t ) => t.active );

	let workersUp = 0;
	let workersTotal = 0;
	let health = 'ok';
	let behindCount = 0;
	let stalledCount = 0;
	for ( const t of actives ) {
		const expected = t.num_partitions > 0 ? t.num_partitions : 1;
		const running = partitionSummaries( t.status?.workers || [] ).filter(
			( p ) => 'running' === p.status
		).length;
		workersTotal += expected;
		workersUp += Math.min( running, expected );

		if ( 'stalled' === t.health ) {
			stalledCount++;
		} else if ( 'behind' === t.health ) {
			behindCount++;
		}
		const rank = HEALTH_RANK[ t.health ] ?? HEALTH_RANK.ok;
		if ( rank < ( HEALTH_RANK[ health ] ?? HEALTH_RANK.ok ) ) {
			health = t.health;
		}
	}

	return {
		topologyCount: list.length,
		activeCount: actives.length,
		workersUp,
		workersTotal,
		health,
		behindCount,
		stalledCount,
	};
}
