<?php
/**
 * Shutdown_Sweeper: a node with unreported state to flush before the graph goes.
 *
 * A worker recycles every ~595s ([ADR-8](docs/architecture-decisions.md#adr-8-worker-zombie-pattern)),
 * so whatever a periodic node accumulated since its last tick is real work that
 * would otherwise die with the process. Implement this and `Worker_Base` calls
 * `shutdown_sweep()` on a CLEAN stop, while the graph is still intact — never on
 * a fatal, where a dead process cannot report anything.
 *
 * Opting in is the whole point: `Worker_Base` names no class.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

interface Shutdown_Sweeper {

	/** Emit the final partial interval. Called once, on a clean stop only. */
	public function shutdown_sweep(): void;
}
