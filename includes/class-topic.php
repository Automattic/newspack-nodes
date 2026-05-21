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

class Topic extends Node {
	protected string $base_dir;
	protected int $num_partitions;
	protected int $segment_size;
	protected int $num_segments;
	protected int $max_lifespan;

	/** @var array<int,Partition> Lazy. */
	protected array $partitions = [];

	protected static int $rr_counter = 0;

	public function __construct(
		string $base_dir,
		int $num_partitions,
		int $segment_size = Partition::DEFAULT_SEGMENT_SIZE,
		int $num_segments = Partition::DEFAULT_NUM_SEGMENTS,
		int $max_lifespan = Partition::DEFAULT_MAX_LIFESPAN
	) {
		$this->base_dir       = \rtrim( $base_dir, '/' );
		$this->num_partitions = \max( 1, $num_partitions );
		$this->segment_size   = $segment_size;
		$this->num_segments   = $num_segments;
		$this->max_lifespan   = $max_lifespan;
		$this->registrations  = [ 'READY' => [] ];
		// Round-trip ctor args so dump_config can re-create this instance.
		$this->arguments = "{$this->base_dir} {$this->num_partitions} {$this->segment_size} {$this->num_segments} {$this->max_lifespan}";
	}

	public function num_partitions(): int {
		return $this->num_partitions;
	}

	/** Override Node::sink() so child Partitions inherit the new sink. */
	public function sink( ?Node $node = null ): ?Node {
		$result = parent::sink( ...\func_get_args() );
		if ( \func_num_args() > 0 ) {
			foreach ( $this->partitions as $p ) {
				$p->sink( $node );
			}
		}
		return $result;
	}

	protected function partition( int $i ): Partition {
		$first = empty( $this->partitions );
		if ( ! isset( $this->partitions[ $i ] ) ) {
			$this->partitions[ $i ] = new Partition(
				$this->base_dir, $i,
				$this->segment_size, $this->num_segments, $this->max_lifespan
			);
			$this->partitions[ $i ]->sink( $this->sink );
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
	 * @param array $message Reference; not mutated.
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
		if ( '' !== $message[ Message::TO ] && \preg_match( '/^p(\d+)/', $message[ Message::TO ], $m ) ) {
			$idx = (int) $m[1];
			if ( $idx >= 0 && $idx < $this->num_partitions ) {
				$this->partition( $idx )->fill( $message );
				return;
			}
		}
		// KEY-routed (or round-robin if KEY empty).
		$key = $message[ Message::KEY ];
		if ( '' !== $key ) {
			$idx = Partition::hash_to_partition( $key, $this->num_partitions );
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
			'category'    => 'Storage',
			'description' => 'Multi-partition log abstraction; routes by hash to one of N Partitions.',
			'ctor'        => [
				[ 'name' => 'base_dir',       'type' => 'string', 'required' => true ],
				[ 'name' => 'num_partitions', 'type' => 'int',    'required' => true, 'default' => '<config:num_partitions>' ],
				[ 'name' => 'segment_size',   'type' => 'int',    'default' => '<config:segment_size>' ],
				[ 'name' => 'num_segments',   'type' => 'int',    'default' => '<config:num_segments>' ],
				[ 'name' => 'max_lifespan',   'type' => 'int',    'default' => '<config:max_lifespan>' ],
			],
			'verbs'       => [],
			'has_target'  => false,
		];
	}
}
