<?php
/**
 * Tick_Housekeeper: a node with storage to keep on the Router tick.
 *
 * A store's rows outlive the reads that want them: a durable Table's expired
 * keys, a Ledger's segments past its lifespan, a SQLite writer's WAL. The
 * Router's tick is the one fixed cadence every worker already pays for, so
 * `Table_Node::tick()` asks each housekeeper what it has to do at `$now` and
 * runs every node's work under ONE budget: the purges first, sharing a
 * deadline, then the checkpoints the deadline left time for, then the trace
 * lines. No node spends the tick's budget on its own.
 *
 * Opting in is the whole point: the tick names no class. It walks the
 * process registry (`Core::$nodes_by_name`), so a housekeeper that never took
 * a name is never ticked.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

interface Tick_Housekeeper {

	/**
	 * This node's work on the tick at `$now`, each step null when none is
	 * due. Answering a step dates the next one, so the tick runs what it is
	 * handed; a step that throws is raised after every other step has run.
	 *
	 * - `purge`: delete what has expired, in batches, until the tick's
	 *   deadline, which it is handed; it runs at least one batch.
	 * - `behind`: whether this node's last purge stopped with a batch still
	 *   full, which widens the tick's budget to its backlog allowance.
	 * - `checkpoint`: write the WAL back, handed the deadline, or null when no
	 *   purge was due; one the purges left no time for waits a tick.
	 * - `trace`: write the node's trace line, last.
	 *
	 * @param int $now The tick, in epoch seconds.
	 * @return array{purge: (\Closure(float): void)|null, behind: bool, checkpoint: (\Closure(?float): void)|null, trace: (\Closure(): void)|null}
	 */
	public function tick_steps( int $now ): array;
}
