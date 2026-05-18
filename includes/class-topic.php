<?php
/**
 * Topic: multi-partition wrapper. Hashes KEY to partition via Partition::hash_to_partition.
 *
 * Storage primitive AND Node. KEY-routed; pre-pinned writes via TO carry partition index.
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
		// Round-trip ctor args so dump_config emits a `make_node Topic ...`
		// line that re-creates this instance.
		$this->arguments = "{$this->base_dir} {$this->num_partitions} {$this->segment_size} {$this->num_segments} {$this->max_lifespan}";
	}

	public function num_partitions(): int {
		return $this->num_partitions;
	}

	/**
	 * Override Node::sink() so child Partitions inherit the new sink — needed because
	 * Partition is the persist-contract terminal and its answer/cancel responses must
	 * flow back along the same path Topic uses.
	 */
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
			// Wire Partition's sink to ours so its persist response (answer/cancel)
			// flows back along the producer's FROM trail through the same path the
			// inbound message arrived on.
			$this->partitions[ $i ]->sink( $this->sink );
		}
		if ( $first ) {
			// Spec line 395: fire READY after first Partition is materialized.
			// set_state caches the payload so late registrants get immediate replay.
			$this->set_state( 'READY', $this->name );
		}
		return $this->partitions[ $i ];
	}

	/**
	 * Node entry point. Pick a partition (pre-pinned TO, KEY hash, or
	 * round-robin) and delegate. All TYPE flags pass through — Topic mirrors
	 * Partition::fill's "generic transport" contract so control messages
	 * (TM_REQUEST, TM_ERROR, TM_EOF) round-trip through Topic-as-bus in IPC
	 * scenarios. Data topics like firehose.log only see TM_BYTESTREAM /
	 * TM_STRUCT in practice, so the broader contract is a no-op there.
	 *
	 * @param array $message Reference; not mutated.
	 */
	public function fill( array &$message ): void {
		++$this->counter;

		// Surface bytes-through + largest message on the Topic itself so
		// the dump_metadata `bytes_written` / `lgst_msg` columns reflect
		// per-Topic flow (not just the underlying Partitions). VALUE size
		// is the canonical "payload that flowed through" measurement,
		// matching Node::fill's largest_msg_sent contract.
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

	/**
	 * Flush every materialized partition's batch — request-scope callers
	 * (LogManager::finish, the cli REPL between commands) use this to land
	 * pending writes without waiting for the size-threshold tick.
	 */
	public function flush(): void {
		foreach ( $this->partitions as $p ) {
			$p->flush();
		}
	}

	/**
	 * Tear down owned Partitions before normal Node teardown so their file handles
	 * close deterministically (matches Partition::remove_node contract).
	 */
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
