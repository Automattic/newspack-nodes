<?php
/**
 * Topic: multi-partition wrapper. Hashes KEY to partition via Partition::hash_to_partition.
 *
 * Class-API contract: constructor must be safe in request scope (no event-loop deps).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topic_Node extends Node {
	protected string $base_dir      = '';
	protected int $num_partitions   = 1;
	protected int $segment_size     = Partition_Node::DEFAULT_SEGMENT_SIZE;
	protected int $num_segments     = Partition_Node::DEFAULT_NUM_SEGMENTS;
	protected int $max_lifespan     = Partition_Node::DEFAULT_MAX_LIFESPAN;

	/** @var array<int,Partition_Node> Lazy. */
	protected array $partitions = [];

	protected static int $rr_counter = 0;

	/**
	 * Tachikoma-parity: no-arg ctor. Positional config arrives via `arguments()`,
	 * which the base setter parses against `node_schema()['arguments']`.
	 */
	public function __construct() {
		$this->registrations = [ 'READY' => [] ];
		// Chain to the base ctor (no-op today — no handler-bearing node_schema
		// verbs — but keeps the :config auto-wire available if any are added).
		parent::__construct();
	}

	/**
	 * Setter chains through the base schema walker, then normalizes the
	 * assigned values (rtrim base_dir, clamp num_partitions to ≥1).
	 *
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$result = parent::arguments( $args );
		if ( '' === $args ) {
			return $result;
		}
		$this->base_dir       = \rtrim( $this->base_dir, '/' );
		$this->num_partitions = \max( 1, $this->num_partitions );
		return $result;
	}

	public function num_partitions(): int {
		return $this->num_partitions;
	}

	/** Override Node::sink() so child Partitions inherit the new sink. */
	public function sink( ?Node $node = null ): ?Node {
		$result = \func_num_args() > 0 ? parent::sink( $node ) : parent::sink();
		if ( \func_num_args() > 0 ) {
			foreach ( $this->partitions as $p ) {
				$p->sink( $node );
			}
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
			$p->arguments( "{$this->base_dir} {$i} {$this->segment_size} {$this->num_segments} {$this->max_lifespan}" );
			// Keep Topic's own sink (specific) and patron-link so dump_metadata hides it from the canvas.
			$p->sink( $this->sink );
			$p->patron( $this );
			$this->partitions[ $i ] = $p;
		}
		if ( $first ) {
			// set_state caches READY so late registrants get immediate replay.
			$this->set_state( 'READY', $this->name );
		}
		return $this->partitions[ $i ];
	}

	/**
	 * Node entry point. Pick a partition (pre-pinned TO, KEY hash, or round-robin) and delegate.
	 *
	 * @param array<int, mixed> $message Reference; not mutated.
	 */
	public function fill( array &$message ): void {
		++$this->counter;

		// Surface bytes-through + largest message on the Topic itself for dump_metadata.
		$packed_size = Message::packed_size( $message );
		$this->bytes_written += $packed_size;
		if ( $packed_size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $packed_size;
		}

		// Pre-pinned via TO: parse partition index out of TO's leading segment.
		$to = self::as_string( $message[ Message::TO ] );
		if ( '' !== $to && \preg_match( '/^p(\d+)/', $to, $m ) ) {
			$idx = (int) $m[1];
			if ( $idx >= 0 && $idx < $this->num_partitions ) {
				$this->partition( $idx )->fill( $message );
				return;
			}
		}
		// KEY-routed (or round-robin if KEY empty).
		$key = self::as_string( $message[ Message::KEY ] );
		if ( '' !== $key ) {
			$idx = Partition_Node::hash_to_partition( $key, $this->num_partitions );
		} else {
			$idx = ( self::$rr_counter++ ) % $this->num_partitions;
		}
		$this->partition( $idx )->fill( $message );
	}

	/** Flush every materialized partition's batch (request-scope callers land pending writes). */
	public function flush(): void {
		foreach ( $this->partitions as $p ) {
			$p->flush();
		}
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
			'category'    => 'I/O',
			'description' => 'Multi-partition log abstraction; routes by hash to one of N Partitions.',
			'arguments'        => [
				[ 'name' => 'base_dir',       'type' => 'string', 'required' => true ],
				[ 'name' => 'num_partitions', 'type' => 'int',    'required' => true ],
				[ 'name' => 'segment_size',   'type' => 'int',    'default' => Partition_Node::DEFAULT_SEGMENT_SIZE ],
				[ 'name' => 'num_segments',   'type' => 'int',    'default' => Partition_Node::DEFAULT_NUM_SEGMENTS ],
				[ 'name' => 'max_lifespan',   'type' => 'int',    'default' => Partition_Node::DEFAULT_MAX_LIFESPAN ],
			],
			'commands'       => [],
			'has_target'  => false,
		];
	}
}
