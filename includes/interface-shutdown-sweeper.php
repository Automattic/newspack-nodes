<?php
/**
 * Shutdown_Sweeper: a node with unreported state to flush before the graph goes.
 *
 * A worker recycles every ~595s ([ADR-8](docs/architecture-decisions.md#adr-8-worker-zombie-pattern)),
 * so whatever a periodic node accumulated since its last tick is real work that
 * would otherwise die with the process. Implement this and `Worker_Base` calls
 * `shutdown_sweep()` on a CLEAN stop, before the cursor handoff and the node
 * teardown, while the graph is still intact.
 *
 * A FATAL skips the whole handoff, sweep included. That gate belongs to the
 * cursors: a graceful checkpoint resets the attempt count a deterministic
 * fatal-poison needs to reach the crash-crawl threshold
 * ([ADR-12](docs/architecture-decisions.md#adr-12-dead-letter-poison--crash-lifecycle)).
 * The sweep rides it.
 *
 * Opting in is the whole point: `Worker_Base` names no class. It sweeps the
 * process registry (`Core::$nodes_by_name`), so an implementor that never took
 * a name is never swept — the same blind spot `Worker_Base` works around by
 * checkpointing the anonymous IPC consumer explicitly.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

interface Shutdown_Sweeper {

	/**
	 * Flush the state this node has not reported yet. Called once, on a clean
	 * stop, after the drain loop has ended — do the work synchronously, because
	 * a timer armed from here never fires. A throw is caught, logged
	 * rate-limited and skipped, so one failing sweeper costs its own window,
	 * not the remaining sweeps or the cursor handoff.
	 */
	public function shutdown_sweep(): void;
}
