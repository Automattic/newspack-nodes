/**
 * Roll the topology rows up to the fleet-level vitals the SummaryCards render:
 * topology/active counts, worker-process liveness (running vs CONFIGURED across
 * active topologies), and worst-health.
 *
 * Worker liveness counts against each active topology's configured
 * `num_partitions` (the expected worker-process count) — NOT the partitions that
 * happened to report a worker in the last snapshot, which under-reports when a
 * worker briefly drops out. `workersUp` is capped at `num_partitions` so a stray
 * duplicate row never shows more up than expected.
 */

import { partitionSummaries } from './partitionSummaries';

// Worst-health rank: lower is worse.
const HEALTH_RANK = { stalled: 0, behind: 1, ok: 2 };

/**
 * @param {Array} topologies Rows from useTopologyManager (active flag,
 *                           num_partitions, health, optional live status.workers).
 * @return {{ topologyCount: number, activeCount: number, workersUp: number,
 *   workersTotal: number, health: string, behindCount: number,
 *   stalledCount: number }} Fleet vitals. `health` is the worst of the active
 *   topologies; `behindCount` and `stalledCount` count the active topologies at
 *   each of those two health levels.
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
