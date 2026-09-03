<?php
/**
 * Topic: the fan-out producer surface, for a log one Partition cannot carry.
 *
 * Everything durable in the substrate lands in a Partition. A Topic lets one
 * producer address N of them as a single node, so widening a log is a topology
 * argument rather than an edit at every call site.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * A router over N `Partition_Node` children sharing one directory template.
 *
 * `fill()` is the only ingress (ADR-1) and picks the partition three ways. A TO
 * already pinned to `p{N}` wins, which is how `wp nodes ingest` replays a record
 * into the partition it came from; otherwise a non-empty KEY routes through
 * `Partition_Node::hash_to_partition()` (ADR-6), the one hash family, so a key's
 * messages stay serial behind one consumer; a message with neither spreads
 * round-robin. Topic batches nothing itself — the message lands in the chosen
 * partition's batch and follows that partition's flush rules.
 *
 * Partitions materialize on first use, and the constructor touches neither the
 * filesystem nor the event loop, so request-scope code can build a Topic
 * (ADR-5). `sink()` is where all N appear at once, because wiring the sink is
 * the moment the Topic can take a message.
 *
 * The three per-partition settings a Topic carries — `allow_large_writes()`,
 * `void_warranty()` and `with_index()` — are recorded here and applied to every
 * partition, the ones built later included, so a setting cannot depend on which
 * partition a key happened to reach first.
 *
 * MULTI-WRITER seam: a Topic whose partitions MANY processes append to (the
 * firehose, written by every request and every worker) is a multi-writer log,
 * and a Consumer reading one MUST opt into the seal grace with
 * `set_multi_writer( true )` (topology: `command_node <consumer>:config
 * set_multi_writer true`), or a peer's straggler append at a segment-rotation
 * boundary is orphaned. A single-writer log needs nothing — its reader advances
 * immediately. See `Consumer_Node::SEAL_GRACE_SECONDS`.
 */
class Topic_Node extends Node {
	/** Positional `arguments()` parsing plus the auto-wired `{name}:config` interpreter. */
	use Schema_Reflection;

	/**
	 * Round-robin cursor for messages carrying no KEY. Static, so every Topic in
	 * the process shares one sequence: the point is spreading keyless traffic,
	 * and a per-instance counter would start every short-lived request-scope
	 * Topic back at partition 0.
	 */
	protected static int $rr_counter = 0;

	/**
	 * Companion-index formatter NAME, propagated to every partition; null = none.
	 * A name rather than the callable, because the name is what `dump_config()`
	 * can emit and a replayed topology can resolve.
	 */
	public ?string $index_formatter_name = null;

	/** Directory path template for the children; `{partition}` is replaced with each index. */
	protected string $dir_template  = '';

	/**
	 * Idle window after which a debounced write lock is freed, in milliseconds;
	 * 0 holds each lock for the partition's life. It means nothing outside
	 * LARGE_WRITE_LOCK, so it travels with the mode rather than on its own.
	 */
	protected int $debounce_lock_ms = 0;

	/** Large-write opt-in propagated to every partition; see Partition_Node's LARGE_WRITE_* trio. */
	protected string $large_write_mode = Partition_Node::LARGE_WRITE_NONE;

	/** Age rule per partition: prune segments older than this many seconds; 0 disables it. */
	protected int $lifetime         = Partition_Node::DEFAULT_LIFETIME;

	/** Hard cap per partition: prune above this many segments unconditionally; 0 derives 2 × num_segments. */
	protected int $max_segments     = Partition_Node::DEFAULT_MAX_SEGMENTS;

	/** Count-rule floor per partition: keep segments younger than this many seconds. */
	protected int $min_lifetime     = Partition_Node::DEFAULT_MIN_LIFETIME;

	/** Age-rule floor per partition: prune no further once this many segments remain. */
	protected int $min_segments     = Partition_Node::DEFAULT_MIN_SEGMENTS;

	/** How many partitions the directory template spans; `arguments()` clamps it to at least 1. */
	protected int $num_partitions   = 1;

	/** Count-rule target per partition: prune the oldest back to this many segments. */
	protected int $num_segments     = Partition_Node::DEFAULT_NUM_SEGMENTS;

	/** @var array<int,Partition_Node> Materialized partitions by index; sparse until `partition()` fills a slot. */
	protected array $partitions = [];

	/** Rotation threshold per partition, in bytes: a write that would exceed it starts a segment. */
	protected int $segment_size     = Partition_Node::DEFAULT_SEGMENT_SIZE;

	/**
	 * Tachikoma-parity: no-arg constructor, with positional config arriving
	 * through `arguments()`. Nothing here touches the filesystem or the event
	 * loop, so request-scope code can build a Topic (ADR-5).
	 */
	public function __construct() {
		parent::__construct();
		// This node's three verbs dispatch through the `{name}:config` sibling.
		$this->auto_wire_interpreter();
	}

	/**
	 * Set or read the positional argument tokens.
	 *
	 * The setter walks them through `parse_schema_args()` (ADR-11), which assigns
	 * each declared position onto its property and stores the raw list, then
	 * normalizes two: `dir_template` loses a trailing slash so the child path
	 * composes cleanly, and `num_partitions` clamps to at least 1 because both
	 * the hash and the round-robin take it modulo. The clamp only ever sees 0 —
	 * a config default that resolved to nothing — since the `int` coercion
	 * already refuses a negative token.
	 *
	 * @param list<string>|null $args New argument tokens (null = pure getter).
	 * @return list<string> The tokens as stored.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		$this->dir_template   = \rtrim( $this->dir_template, '/' );
		$this->num_partitions = \max( 1, $this->num_partitions );
		return $args;
	}

	/**
	 * Node entry point (ADR-1): pick a partition and delegate the message to it.
	 *
	 * A TO whose leading segment reads `p{N}` and names a partition in range
	 * wins, which is how a replay lands a record back in the partition it came
	 * from; an out-of-range index falls through to the hash instead of failing,
	 * so a replay into a narrower Topic still lands. A non-empty KEY then routes
	 * through `Partition_Node::hash_to_partition()` (ADR-6). A message with
	 * neither takes the next round-robin slot.
	 *
	 * @param array<int,mixed> $message The 7-field positional message; not mutated.
	 */
	public function fill( array $message ): void {
		++$this->counter;

		// Pre-pinned via TO: parse partition index out of TO's leading segment.
		$to = Core::as_string( $message[ Message::TO ] );
		if ( '' !== $to && \preg_match( '/^p(\d+)/', $to, $m ) ) {
			$idx = (int) $m[1];
			if ( $idx >= 0 && $idx < $this->num_partitions ) {
				$this->partition( $idx )->fill( $message );
				return;
			}
		}
		// KEY-routed (or round-robin if KEY empty).
		$key = Core::as_string( $message[ Message::KEY ] );
		if ( '' !== $key ) {
			$idx = Partition_Node::hash_to_partition( $key, $this->num_partitions );
		} else {
			$idx = ( self::$rr_counter++ ) % $this->num_partitions;
		}
		$this->partition( $idx )->fill( $message );
	}

	/**
	 * Lift the 4KB PIPE_BUF cap on every partition behind a held write lock
	 * (ADR-4), partitions materialized later included. Each one waits
	 * `Partition_Node::DEFAULT_LOCK_WAIT_MS` for its lock; a Topic exposes no
	 * per-call timeout. See `Partition_Node::allow_large_writes()`.
	 *
	 * @param int $debounce_ms 0 holds each lock for life; above 0 takes it per write burst and frees it after that much quiet.
	 * @throws \RuntimeException When a partition cannot acquire its write lock.
	 * @return self
	 */
	public function allow_large_writes( int $debounce_ms = 0 ): self {
		return $this->set_large_write_mode( Partition_Node::LARGE_WRITE_LOCK, \max( 0, $debounce_ms ) );
	}

	/**
	 * Lift the cap on every partition with NO lock, on the caller's assertion
	 * that it is the sole writer (ADR-4). Two concurrent writers under this tear
	 * records silently; where single-writer is not guaranteed, take
	 * `allow_large_writes()`, which enforces exclusivity rather than trusting
	 * it. See `Partition_Node::void_warranty()`.
	 *
	 * @return self
	 */
	public function void_warranty(): self {
		return $this->set_large_write_mode( Partition_Node::LARGE_WRITE_VOID );
	}

	/**
	 * Name the companion-index formatter every partition writes its `.idx` lines
	 * through, applying it to the partitions already materialized and recording
	 * it for the ones built later. See `Partition_Node::with_index_named()`.
	 *
	 * @param string $formatter_name Registered `Formatters` name.
	 * @return self
	 */
	public function with_index( string $formatter_name ): self {
		$this->index_formatter_name = $formatter_name;
		foreach ( $this->partitions as $p ) {
			$this->apply_index( $p );
		}
		return $this;
	}

	/**
	 * The ONE write of the mode AND of the debounce that travels with it.
	 *
	 * The debounce means nothing except under `_LOCK`, and a re-arm that changes
	 * it has to reach the partitions already materialized, or the live topic
	 * holds its locks for life while `dump_config()` advertises a debounce only a
	 * replayed topology would honour. A repeat call in the same mode with the
	 * same debounce returns early, because `Partition_Node::allow_large_writes()`
	 * re-locks on every call.
	 *
	 * @param string $mode        One of Partition_Node's LARGE_WRITE_* values.
	 * @param int    $debounce_ms Idle window before a debounced lock is freed; 0 holds it.
	 * @throws \RuntimeException When a partition cannot acquire its write lock.
	 * @return self
	 */
	private function set_large_write_mode( string $mode, int $debounce_ms = 0 ): self {
		if ( $mode === $this->large_write_mode && $debounce_ms === $this->debounce_lock_ms ) {
			return $this;
		}
		$this->large_write_mode = $mode;
		$this->debounce_lock_ms = $debounce_ms;
		foreach ( $this->partitions as $p ) {
			$this->apply_large_write_mode( $p );
		}
		return $this;
	}

	/**
	 * Set or read the sink, cascading a set to every partition and then
	 * announcing READY.
	 *
	 * Wiring the sink also materializes all N partitions, because that is the
	 * moment the Topic can take a message and the node registry is what `ls`
	 * walks — a partition nothing has written to yet still belongs in it.
	 * Registrants arriving after this get READY's cached payload.
	 *
	 * @param Node|null $node New sink; omit the argument entirely to read.
	 * @return Node|null The current sink.
	 */
	public function sink( ?Node $node = null ): ?Node {
		if ( 0 === \func_num_args() ) {
			return parent::sink();
		}
		$result = parent::sink( $node );
		// The registry is what `ls` walks; an unwritten partition is in it.
		for ( $i = 0; $i < $this->num_partitions; ++$i ) {
			$this->partition( $i );
		}
		$this->set_state( 'READY', $this->name );
		return $result;
	}

	/**
	 * The partition at index $i, materialized on first use (ADR-5).
	 *
	 * The build order is load-bearing. The child takes the Topic's sink and a
	 * patron link, so `dump_metadata` hides it; it is published into its `p{i}`
	 * slot before the large-write mode is applied, because acquiring a write lock
	 * names a sibling of its own; and it reaches `$this->partitions` last, so a
	 * build that throws leaves neither a cached partition nor a registration
	 * behind, and the next message rebuilds from the start.
	 *
	 * @param int $i Zero-based partition index.
	 * @throws \Throwable Whatever applying the large-write mode raised; the `p{i}` slot is emptied first.
	 * @return Partition_Node The partition at that index.
	 */
	protected function partition( int $i ): Partition_Node {
		if ( ! isset( $this->partitions[ $i ] ) ) {
			$p         = new Partition_Node();
			$child_dir = \str_replace( '{partition}', (string) $i, $this->dir_template );
			$p->arguments( [ $child_dir, (string) $this->segment_size, (string) $this->min_segments, (string) $this->num_segments, (string) $this->max_segments, (string) $this->min_lifetime, (string) $this->lifetime ] );
			// Topic's sink + patron-link, so dump_metadata hides it.
			$p->sink( $this->sink );
			$p->patron( $this );
			$this->apply_index( $p );
			// Named from its `p{i}` slot; :lock and :config derive.
			$this->publish_sibling( "p{$i}", $p );
			try {
				// Needs the name: it acquires a lock through a named sibling.
				$this->apply_large_write_mode( $p );
			} catch ( \Throwable $e ) {
				$this->retract_sibling( "p{$i}" );
				throw $e;
			}
			// Cached last: a refused partition is never served cap-lifted.
			$this->partitions[ $i ] = $p;
		}
		return $this->partitions[ $i ];
	}

	/**
	 * Apply the named index formatter to one partition. An unregistered name is a
	 * no-op here — `cmd_with_index()` is where a bad name is refused.
	 *
	 * @param Partition_Node $p The partition to configure.
	 */
	private function apply_index( Partition_Node $p ): void {
		if ( null !== $this->index_formatter_name ) {
			$p->with_index_named( $this->index_formatter_name );
		}
	}

	/**
	 * Apply the current large-write mode to one partition, freshly materialized
	 * or already live. LARGE_WRITE_NONE is the no-op branch: a Topic lifts a cap
	 * and never puts one back down.
	 *
	 * @param Partition_Node $p The partition to configure.
	 * @throws \RuntimeException When the partition cannot acquire its write lock.
	 */
	private function apply_large_write_mode( Partition_Node $p ): void {
		if ( Partition_Node::LARGE_WRITE_LOCK === $this->large_write_mode ) {
			$p->allow_large_writes( Partition_Node::DEFAULT_LOCK_WAIT_MS, $this->debounce_lock_ms );
		} elseif ( Partition_Node::LARGE_WRITE_VOID === $this->large_write_mode ) {
			$p->void_warranty();
		}
	}

	/**
	 * `allow_large_writes` verb — lift the cap on every partition, with the lock.
	 *
	 * @param Command_Interpreter_Node $interpreter Owning interpreter; its patron is the Topic.
	 * @param array<array-key,mixed>  $args        Positional args; [0] is an optional debounce_ms.
	 * @throws \RuntimeException When a partition cannot acquire its write lock.
	 * @return string `"ok\n"`.
	 */
	public static function cmd_allow_large_writes( Command_Interpreter_Node $interpreter, array $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->allow_large_writes( \max( 0, Core::as_int( $args[0] ?? '' ) ) );
		return "ok\n";
	}

	/**
	 * `void_warranty` verb — lift the cap on every partition with NO lock.
	 *
	 * @param Command_Interpreter_Node $interpreter Owning interpreter; its patron is the Topic.
	 * @return string `"ok\n"`.
	 */
	public static function cmd_void_warranty( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->void_warranty();
		return "ok\n";
	}

	/**
	 * `with_index` verb — name the companion-index formatter for every partition.
	 *
	 * @param Command_Interpreter_Node $interpreter Owning interpreter; its patron is the Topic.
	 * @param array<array-key,mixed>  $args        Positional args; [0] is the formatter name.
	 * @throws \RuntimeException When the name is missing or names no registered formatter.
	 * @return string `"ok\n"`.
	 */
	public static function cmd_with_index( Command_Interpreter_Node $interpreter, array $args ): string {
		$args = Core::as_string( $args[0] ?? '' );
		if ( '' === $args ) {
			throw new \RuntimeException( 'usage: with_index <formatter_name>' );
		}
		if ( null === Formatters::resolve( $args ) ) {
			throw new \RuntimeException( \esc_html( "unknown formatter: $args" ) );
		}
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->with_index( $args );
		return "ok\n";
	}

	/**
	 * Emit the base `make_node` line plus one config line per verb that is set,
	 * read back from STATE rather than from what a caller passed, so a replayed
	 * topology arrives at the same modes. Partition's does the same.
	 *
	 * @return string The `make_node` line and its config lines.
	 */
	public function dump_config(): string {
		$out = parent::dump_config();
		if ( Partition_Node::LARGE_WRITE_VOID === $this->large_write_mode ) {
			$out .= $this->config_line( 'void_warranty' );
		} elseif ( Partition_Node::LARGE_WRITE_LOCK === $this->large_write_mode ) {
			$out .= $this->debounce_lock_ms > 0
				? $this->config_line( 'allow_large_writes', (string) $this->debounce_lock_ms )
				: $this->config_line( 'allow_large_writes' );
		}
		if ( null !== $this->index_formatter_name ) {
			$out .= $this->config_line( 'with_index', $this->index_formatter_name );
		}
		return $out;
	}

	/**
	 * Flush every materialized partition's batch. A request-scope producer calls
	 * it before handing off to a subprocess that appends to the same directory,
	 * so its own messages land ahead of the child's rather than after them.
	 *
	 * @api
	 */
	public function flush(): void {
		foreach ( $this->partitions as $p ) {
			$p->flush();
		}
	}

	/** Largest single record any materialized partition has written, in bytes. */
	public function largest_msg_sent(): int {
		$max = 0;
		foreach ( $this->partitions as $p ) {
			$max = \max( $max, $p->largest_msg_sent() );
		}
		return $max;
	}

	/** Bytes written, summed across every materialized partition. */
	public function bytes_written(): int {
		$sum = 0;
		foreach ( $this->partitions as $p ) {
			$sum += $p->bytes_written();
		}
		return $sum;
	}

	/**
	 * Tear the Topic down and forget the partitions. The base cascade removes
	 * them as owned siblings; dropping the cache too is what stops a later
	 * `fill()` handing a message to a node that is already gone.
	 */
	public function remove_node(): void {
		parent::remove_node();
		$this->partitions = [];
	}

	/**
	 * Topology console manifest: the palette entry, the eight positional
	 * arguments `parse_schema_args()` assigns, and the three config verbs.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'      => 'I/O',
			'description'   => 'Multi-partition log abstraction; routes by hash to one of N Partitions.',
			'arguments'        => [
				[ 'name' => 'dir_template',   'type' => 'string', 'required' => true, 'description' => 'Per-partition directory path template; the {partition} token is replaced with each index 0..N-1.' ],
				[ 'name' => 'num_partitions', 'type' => 'int',    'default'  => '<config:num_partitions>', 'description' => 'Number of partitions to spread writes across; a message\'s KEY is CRC32-routed to one (default 1).' ],
				[ 'name' => 'segment_size',   'type' => 'int',    'default' => '<config:segment_size>', 'description' => 'Segment rotation threshold in bytes; a new segment starts once a write would exceed it (default 64 MiB).' ],
				[ 'name' => 'min_segments',   'type' => 'int',    'default' => '<config:min_segments>', 'description' => 'Age-rule floor per partition: keep at least this many segments (hard minimum 2).' ],
				[ 'name' => 'num_segments',   'type' => 'int',    'default' => '<config:num_segments>', 'description' => 'Count-rule target per partition: prune the oldest back to this many segments (older than min_lifetime).' ],
				[ 'name' => 'max_segments',   'type' => 'int',    'default' => '<config:max_segments>', 'description' => 'True hard cap per partition: prune the oldest UNCONDITIONALLY above this many segments. 0 = derive as 2 × num_segments.' ],
				[ 'name' => 'min_lifetime',   'type' => 'int',    'default' => '<config:min_lifetime>', 'description' => 'Count-rule floor per partition: keep segments younger than this many seconds; 0 keeps nothing extra.' ],
				[ 'name' => 'lifetime',       'type' => 'int',    'default' => '<config:lifetime>', 'description' => 'Age rule per partition: prune segments older than this many seconds down to min_segments; 0 disables it.' ],
			],
			'commands'      => [
				[
					'name'        => 'allow_large_writes',
					'description' => 'Lift the 4KB PIPE_BUF cap on every partition via a held write lock; propagates to partitions materialized later. Optional debounce_ms > 0 locks per write burst.',
					'args'        => [
						[ 'name' => 'debounce_ms', 'type' => 'int', 'required' => false ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_allow_large_writes( $interpreter, $args ),
				],
				[
					'name'        => 'void_warranty',
					'description' => 'Lift the 4KB cap on every partition with NO write lock — caller asserts single-writer. Propagates to partitions materialized later.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_void_warranty( $interpreter ),
				],
				[
					'name'        => 'with_index',
					'description' => 'Use a named line-formatter for every partition\'s companion index file.',
					'args'        => [
						[ 'name' => 'formatter', 'type' => 'formatter_name', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, array $args ): string => self::cmd_with_index( $interpreter, $args ),
				],
			],
			'registrations' => [ 'READY' ],
			'has_target'    => false,
		];
	}
}
