<?php
/**
 * The periodic per-worker stats sweep every probe subclass inherits.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Probe_Node: the sweep itself, shared by `Topic_Probe`, `Job_Probe` and
 * `Table_Probe`.
 *
 * Each worker process runs one probe, sweeping ITS local nodes
 * (`Core::$nodes_by_name`, our analog of Tachikoma's `%Tachikoma::Nodes`) and
 * emitting lean positional TM_STRUCT records into a shared log. One record per
 * emit — never a batch — keeps every append under the 4KB cap
 * ([ADR-4](docs/architecture-decisions.md#adr-4-pipe_buf-atomic-writes)), so the
 * shared log stays multi-writer atomic with no lock and no oversize drop. The
 * Message TIMESTAMP is the snapshot instant and is never duplicated into the
 * VALUE.
 *
 * Every record is SELF-CONTAINED: the work done since that source's previous
 * sweep plus the interval it covers, so a reader divides ONE record and a ~595s
 * worker recycle is another window rather than a counter reset. A sweep DRAINS
 * each accumulator, so exactly one probe of a kind may run per process — two
 * would split every window between them and each report half the work.
 *
 * A subclass declares `probe()` — which nodes it claims, and how many records
 * each yields — a `node_schema()` description, and
 * `fit_to_line()` when its record carries a field that can overflow the cap.
 * Everything else below is the sweep.
 */
abstract class Probe_Node extends Timer_Node implements Shutdown_Sweeper {

	/** Sweep cadence a topology may omit; `node_schema()` names it as the `interval_s` default. */
	protected const DEFAULT_INTERVAL_S = 15;

	/**
	 * Sweep cadence in seconds, positional 0 in every subclass's schema.
	 *
	 * `arguments()` arms the base Timer through `cadence_ms()`, whose one-second
	 * floor holds the interval at or above the Router's tick. The sweep therefore
	 * rides the Router TIMER rather than taking an own event-loop slot, and
	 * `Timer_Node::fire_cb()` throttles that tick back down to this cadence.
	 */
	protected int $interval_s = self::DEFAULT_INTERVAL_S;

	/** The worker this probe sweeps in, `{topology}.p{N}`, read when its arguments arrive. */
	private string $worker_id;

	/**
	 * Read the positional tokens, or apply them and arm the sweep timer.
	 *
	 * `parse_schema_args()` assigns `interval_s` from the subclass schema, and
	 * that declaration is the whole parse
	 * ([ADR-11](docs/architecture-decisions.md#adr-11-make_node-construction-sequence)).
	 * A probe hand-parsing its own cadence beside the schema that already
	 * declares it is the duplication that ADR exists to prevent.
	 *
	 * The worker id is read first, so a probe built outside a worker — a bare
	 * `wp nodes cli` binds nothing — is refused here, as `make_node`'s
	 * TM_ERROR, before a timer is armed, rather than throwing on a later tick.
	 *
	 * @param list<string>|null $args New argument tokens (null = pure getter).
	 * @return list<string> Last-set argument tokens.
	 * @throws \LogicException Outside a worker, from `bound_worker_id()`.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return $this->arguments;
		}
		$this->worker_id = $this->bound_worker_id();
		$this->parse_schema_args( $args );
		$this->set_timer( $this->cadence_ms( $this->interval_s ) );
		return $this->arguments;
	}

	/**
	 * Sweep every node this probe claims and emit one TM_STRUCT per record.
	 *
	 * `Timer_Node::fire_cb()` calls this once `interval_ms` has elapsed, which is
	 * the throttle over the Router's every-second tick. FIRE notifies before the
	 * sink guard: `fire_cb()` already returns on a null sink, so the guard exists
	 * for `shutdown_sweep()`, which reaches `fire()` directly.
	 *
	 * Every node is swept whatever another threw — a Consumer that has read no
	 * segment yet must not cost its healthy peers their window — and every
	 * failure escapes after the last. No claimable nodes, or a claimed one with
	 * nothing recorded yet, emits nothing at all.
	 *
	 * @throws \Throwable What the sweep threw, combined by `Worker_Should_Stop::raise()`.
	 */
	protected function fire(): void {
		$this->notify( 'FIRE', Core::$now );
		$sink = $this->sink;
		if ( null === $sink ) {
			return;
		}
		$from = "{$this->worker_id}/{$this->name}";
		// Swept work re-pins Core::$now; read the sweep instant once.
		$instant = Core::$now;
		$this->sweep_started();
		Worker_Should_Stop::raise(
			Worker_Should_Stop::attempt_each( Core::$nodes_by_name, fn ( Node $node ) => $this->sweep( $node, $sink, $from, $instant ) )
		);
	}

	/** Hook: a probe clears its per-sweep state here, before the first node. */
	protected function sweep_started(): void {
	}

	/**
	 * The worker id every record's FROM opens with, `{worker-id}/{probe-name}`
	 * such as `job-worker.p2/jobstats`, so a reader charts each worker's
	 * stream apart while the record layout stays as it is. A probe runs only
	 * in a worker, where `Topology_Loader` binds the topology and the
	 * partition before the graph is built, so either missing is refused by
	 * name, and `Core::bound_partition()` refuses a partition that is not
	 * canonical.
	 *
	 * @return string The worker id.
	 * @throws \LogicException Naming the half of the worker id not bound, or
	 *                         the partition that is not canonical.
	 */
	private function bound_worker_id(): string {
		$topology = Core::bound_topology()
			?? throw new \LogicException( \esc_html( "{$this->name}: no topology bound; a probe runs only in a worker" ) );
		$partition = Core::bound_partition()
			?? throw new \LogicException( \esc_html( "{$this->name}: no partition bound; a probe runs only in a worker" ) );
		return CLI::worker_id( $topology, $partition );
	}

	/**
	 * Emit one TM_STRUCT per record this probe takes from `$node`, each
	 * stamped FROM `{worker-id}/{probe-name}`.
	 *
	 * @param Node   $node A node from this process's registry.
	 * @param Node   $sink Where the records go.
	 * @param string $from The FROM each record carries, `{worker-id}/{probe-name}`.
	 * @param float  $instant The sweep's one instant, every record's TIMESTAMP.
	 */
	private function sweep( Node $node, Node $sink, string $from, float $instant ): void {
		foreach ( $this->probe( $node ) as $record ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_STRUCT;
			$message[ Message::TIMESTAMP ] = $instant;
			$message[ Message::FROM ]  = $from;
			$message[ Message::TO ]    = $this->target;
			$message[ Message::VALUE ] = $record;
			$fitted                    = $this->fit_to_line( $message );
			if ( null === $fitted ) {
				continue;
			}
			++$this->counter;
			$sink->fill( $fitted );
		}
	}

	/**
	 * The records this probe takes from one swept node — empty for a node it does
	 * not claim, which is how the sweep set is declared. A DRAINING read: the
	 * sweep calls it once per node per tick, and the accumulator behind it
	 * re-baselines, which is what makes each record a self-contained window.
	 *
	 * @param Node $node A node from this process's registry.
	 * @return array<int,array<int,mixed>> Positional records.
	 */
	abstract protected function probe( Node $node ): array;

	/**
	 * Records emit as minted. A probe whose record carries a free-text field that
	 * can overflow the 4KB cap overrides this to trim that field through
	 * `Line_Fitter`, and to drop loud when nothing is left to trim; one whose
	 * record is all bounded fields must not, since halving an identity would
	 * corrupt what readers key on.
	 *
	 * @param array<int,mixed> $message The minted record message.
	 * @return array<int,mixed>|null The message to emit, or null to drop it.
	 */
	protected function fit_to_line( array $message ): ?array {
		return $message;
	}

	/**
	 * Flush the window since the last tick — work the interval gate would
	 * otherwise swallow when the worker recycles mid-interval. Implementing
	 * `Shutdown_Sweeper` is what makes `Worker_Base` call it.
	 */
	public function shutdown_sweep(): void {
		$this->fire();
	}
	/**
	 * Topology console manifest shared by every probe: the `Monitor` palette
	 * entry and the one `interval_s` positional. Declaring it here is the whole
	 * parse — ADR-11 puts defaults and coercion in `parse_schema_args()`. A
	 * subclass merges its own `description` over it.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'  => 'Monitor',
			'arguments' => [
				[ 'name' => 'interval_s', 'type' => 'int', 'default' => self::DEFAULT_INTERVAL_S, 'description' => 'Sweep cadence in seconds; empty or absent defaults to 15.' ],
			],
		] );
	}
}
