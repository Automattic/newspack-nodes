<?php
/**
 * Topic: multi-partition wrapper. Hashes KEY to partition via Partition::hash_to_partition.
 *
 * Class-API contract: constructor must be safe in request scope (no event-loop deps).
 *
 * MULTI-WRITER seam: a Topic whose partitions are appended to by MANY processes
 * (e.g. the firehose, written by every request/worker) is a multi-writer log. A
 * Consumer reading such a log MUST opt into the seal-grace via
 * `set_multi_writer(true)` (topology: `cmd <consumer>:config set_multi_writer true`),
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

	protected string $dir_template  = '';

	/** Large-write opt-in propagated to every partition: '' none, 'lock' (allow_large_writes), 'void' (void_warranty). */
	protected string $large_write_mode = '';
	protected int $max_lifespan     = Partition_Node::DEFAULT_MAX_LIFESPAN;
	protected int $num_partitions   = 1;
	protected int $num_segments     = Partition_Node::DEFAULT_NUM_SEGMENTS;

	/** @var array<int,Partition_Node> Lazy. */
	protected array $partitions = [];
	protected int $segment_size     = Partition_Node::DEFAULT_SEGMENT_SIZE;

	/** Tachikoma-parity: no-arg ctor. Positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Store the raw string, parse positional tokens via parse_schema_args(), then
	 * normalize (rtrim dir_template, clamp num_partitions to ≥1).
	 *
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
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
	public function allow_large_writes(): self {
		return $this->set_large_write_mode( 'lock' );
	}

	/** Lift the 4KB cap on every partition with NO lock — caller asserts single-writer. See Partition_Node::void_warranty(). */
	public function void_warranty(): self {
		return $this->set_large_write_mode( 'void' );
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
		$first = empty( $this->partitions );
		if ( ! isset( $this->partitions[ $i ] ) ) {
			$p = new Partition_Node();
			// Name the sibling `{topic}:p{i}` (mirrors Consumer's `{name}:source`) when the Topic is named.
			if ( '' !== $this->name ) {
				$p->name( "{$this->name}:p{$i}" );
			}
			$child_dir = \str_replace( '{partition}', (string) $i, $this->dir_template );
			$p->arguments( "{$child_dir} {$this->segment_size} {$this->num_segments} {$this->max_lifespan}" );
			// Keep Topic's own sink (specific) and patron-link so dump_metadata hides it from the canvas.
			$p->sink( $this->sink );
			$p->patron( $this );
			$this->apply_large_write_mode( $p );
			$this->partitions[ $i ] = $p;
		}
		return $this->partitions[ $i ];
	}

	/** Apply the current large-write mode to one freshly-materialized partition (called once per partition, at creation). */
	private function apply_large_write_mode( Partition_Node $p ): void {
		if ( 'lock' === $this->large_write_mode ) {
			$p->allow_large_writes();
		} elseif ( 'void' === $this->large_write_mode ) {
			$p->void_warranty();
		}
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
			$max = max( $max, $p->largest_msg_sent() );
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
				[ 'name' => 'dir_template',   'type' => 'string', 'required' => true ],
				[ 'name' => 'num_partitions', 'type' => 'int',    'default'  => 1 ],
				[ 'name' => 'segment_size',   'type' => 'int',    'default' => Partition_Node::DEFAULT_SEGMENT_SIZE ],
				[ 'name' => 'num_segments',   'type' => 'int',    'default' => Partition_Node::DEFAULT_NUM_SEGMENTS ],
				[ 'name' => 'max_lifespan',   'type' => 'int',    'default' => Partition_Node::DEFAULT_MAX_LIFESPAN ],
			],
			'commands'      => [],
			'registrations' => [ 'READY' ],
			'has_target'    => false,
		];
	}
}
