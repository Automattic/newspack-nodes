<?php
/**
 * Topic: multi-partition wrapper. Hashes KEY to partition via Partition::hash_to_partition.
 *
 * Class-API contract: constructor must be safe in request scope (no event-loop deps).
 *
 * MULTI-WRITER seam: a Topic whose partitions are appended to by MANY processes
 * (e.g. the firehose, written by every request/worker) is a multi-writer log. A
 * Consumer reading such a log MUST opt into the seal-grace via
 * `set_multi_writer(true)` (topology: `command_node <consumer>:config set_multi_writer true`),
 * or a peer's straggler append at a segment-rotation boundary is orphaned. A
 * single-writer log (one process appends) needs nothing — its reader advances
 * immediately. See Consumer_Node::SEAL_GRACE_SECONDS.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topic_Node extends Node {
	use Schema_Reflection;

	protected static int $rr_counter = 0;

	/** Companion-index formatter NAME, propagated to every partition; null = none. */
	public ?string $index_formatter_name = null;

	protected string $dir_template  = '';

	/** Debounce for 'lock' mode, propagated with it. */
	protected int $large_write_debounce_ms = 0;

	/** Large-write opt-in propagated to every partition: '' none, 'lock' (allow_large_writes), 'void' (void_warranty). */
	protected string $large_write_mode = '';
	protected int $lifetime         = Partition_Node::DEFAULT_LIFETIME;
	protected int $max_segments     = Partition_Node::DEFAULT_MAX_SEGMENTS;
	protected int $min_lifetime     = Partition_Node::DEFAULT_MIN_LIFETIME;
	protected int $min_segments     = Partition_Node::DEFAULT_MIN_SEGMENTS;
	protected int $num_partitions   = 1;
	protected int $num_segments     = Partition_Node::DEFAULT_NUM_SEGMENTS;

	/** @var array<int,Partition_Node> Lazy. */
	protected array $partitions = [];
	protected int $segment_size     = Partition_Node::DEFAULT_SEGMENT_SIZE;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();
		// The Partition verbs dispatch through the `{name}:config` sibling.
		$this->auto_wire_interpreter();
	}

	/**
	 * Store the raw string, parse positional tokens via parse_schema_args(), then
	 * normalize (rtrim dir_template, clamp num_partitions to ≥1).
	 *
	 * @param list<string>|null $args
	 * @return list<string>
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
	 * Node entry point. Pick a partition (pre-pinned TO, KEY hash, or round-robin) and delegate.
	 *
	 * @param array<int, mixed> $message Reference; not mutated.
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

	/** Lift the 4KB cap on every partition via a held write lock — propagates to future children too. See Partition_Node::allow_large_writes(). */
	public function allow_large_writes( int $debounce_ms = 0 ): self {
		$this->large_write_debounce_ms = \max( 0, $debounce_ms );
		return $this->set_large_write_mode( 'lock' );
	}

	/** Lift the 4KB cap on every partition with NO lock — caller asserts single-writer. See Partition_Node::void_warranty(). */
	public function void_warranty(): self {
		return $this->set_large_write_mode( 'void' );
	}

	/** Name the companion-index formatter; applies to every partition, including ones materialized later. See Partition_Node::with_index(). */
	public function with_index( string $formatter_name ): self {
		$this->index_formatter_name = $formatter_name;
		foreach ( $this->partitions as $p ) {
			$this->apply_index( $p );
		}
		return $this;
	}

	/** Set the mode once and apply to already-materialized partitions; a repeat call in the same mode is a no-op (Partition::allow_large_writes re-locks). */
	private function set_large_write_mode( string $mode ): self {
		if ( $mode === $this->large_write_mode ) {
			return $this;
		}
		$this->large_write_mode = $mode;
		foreach ( $this->partitions as $p ) {
			$this->apply_large_write_mode( $p );
		}
		return $this;
	}

	/** Override Node::sink() so child Partitions inherit the new sink. */
	public function sink( ?Node $node = null ): ?Node {
		$result = \func_num_args() > 0 ? parent::sink( $node ) : parent::sink();
		if ( \func_num_args() > 0 ) {
			for ( $i = 0; $i < $this->num_partitions; ++$i ) {
				$this->partition( $i )->sink( $node );
			}
			$this->set_state( 'READY', $this->name );
		}
		return $result;
	}

	protected function partition( int $i ): Partition_Node {
		if ( ! isset( $this->partitions[ $i ] ) ) {
			$p = new Partition_Node();
			// Name the sibling `{topic}:p{i}` when the Topic is named.
			if ( '' !== $this->name ) {
				$p->name( "{$this->name}:p{$i}" );
			}
			$child_dir = \str_replace( '{partition}', (string) $i, $this->dir_template );
			$p->arguments( [ $child_dir, (string) $this->segment_size, (string) $this->min_segments, (string) $this->num_segments, (string) $this->min_lifetime, (string) $this->lifetime, (string) $this->max_segments ] );
			// Keep Topic's sink + patron-link so dump_metadata hides it.
			$p->sink( $this->sink );
			$p->patron( $this );
			$this->apply_large_write_mode( $p );
			$this->apply_index( $p );
			$this->partitions[ $i ] = $p;
		}
		return $this->partitions[ $i ];
	}

	/** Apply the named index formatter to one partition; unknown name is a no-op. */
	private function apply_index( Partition_Node $p ): void {
		if ( null !== $this->index_formatter_name ) {
			$p->with_index_named( $this->index_formatter_name );
		}
	}

	/** Apply the current large-write mode to one freshly-materialized partition (called once per partition, at creation). */
	private function apply_large_write_mode( Partition_Node $p ): void {
		if ( 'lock' === $this->large_write_mode ) {
			$p->allow_large_writes( 65000, $this->large_write_debounce_ms );
		} elseif ( 'void' === $this->large_write_mode ) {
			$p->void_warranty();
		}
	}

	/**
	 * `allow_large_writes` verb — lift the cap on every partition, with the lock.
	 *
	 * @param Command_Interpreter_Node $interpreter Owning interpreter.
	 * @param array<array-key, mixed>  $args        Optional debounce_ms.
	 */
	public static function cmd_allow_large_writes( Command_Interpreter_Node $interpreter, array $args ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->allow_large_writes( \max( 0, Core::as_int( $args[0] ?? '' ) ) );
		return 'ok';
	}

	/**
	 * `void_warranty` verb — lift the cap on every partition with NO lock.
	 *
	 * @param Command_Interpreter_Node $interpreter Owning interpreter.
	 */
	public static function cmd_void_warranty( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->void_warranty();
		return 'ok';
	}

	/**
	 * `with_index` verb — name the companion-index formatter for every partition.
	 *
	 * @param Command_Interpreter_Node $interpreter Owning interpreter.
	 * @param array<array-key, mixed>  $args        Formatter name.
	 */
	public static function cmd_with_index( Command_Interpreter_Node $interpreter, array $args ): string {
		$args = Core::as_string( $args[0] ?? '' );
		if ( '' === $args ) {
			return 'usage: with_index <formatter_name>';
		}
		if ( null === Formatters::resolve( $args ) ) {
			return "unknown formatter: $args";
		}
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->with_index( $args );
		return 'ok';
	}

	/** Emit the base config plus the verb-config, from STATE — like Partition's. */
	public function dump_config(): string {
		$out = parent::dump_config();
		if ( 'void' === $this->large_write_mode ) {
			$out .= "command_node {$this->name}:config void_warranty\n";
		} elseif ( 'lock' === $this->large_write_mode ) {
			$verb = $this->large_write_debounce_ms > 0
				? "allow_large_writes {$this->large_write_debounce_ms}"
				: 'allow_large_writes';
			$out .= "command_node {$this->name}:config {$verb}\n";
		}
		if ( null !== $this->index_formatter_name ) {
			$out .= "command_node {$this->name}:config with_index {$this->index_formatter_name}\n";
		}
		return $out;
	}

	/** @api Flush every materialized partition's batch (request-scope callers land pending writes). */
	public function flush(): void {
		foreach ( $this->partitions as $p ) {
			$p->flush();
		}
	}

	public function largest_msg_sent(): int {
		$max = 0;
		foreach ( $this->partitions as $p ) {
			$max = \max( $max, $p->largest_msg_sent() );
		}
		return $max;
	}

	public function bytes_written(): int {
		$sum = 0;
		foreach ( $this->partitions as $p ) {
			$sum += $p->bytes_written();
		}
		return $sum;
	}

	/** Tear down owned Partitions before normal Node teardown so file handles close deterministically. */
	public function remove_node(): void {
		foreach ( $this->partitions as $p ) {
			$p->remove_node();
		}
		$this->partitions = [];
		parent::remove_node();
	}

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
				[ 'name' => 'min_lifetime',   'type' => 'int',    'default' => '<config:min_lifetime>', 'description' => 'Count-rule floor per partition: keep segments younger than this many seconds; 0 keeps nothing extra.' ],
				[ 'name' => 'lifetime',       'type' => 'int',    'default' => '<config:lifetime>', 'description' => 'Age rule per partition: prune segments older than this many seconds down to min_segments; 0 disables it.' ],
				[ 'name' => 'max_segments',   'type' => 'int',    'default' => '<config:max_segments>', 'description' => 'True hard cap per partition: prune the oldest UNCONDITIONALLY above this many segments. 0 = derive as 2 × num_segments.' ],
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
