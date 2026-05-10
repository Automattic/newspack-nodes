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

	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];

		// TM_REQUEST: introspection (GET_PARTITIONS).
		if ( $type & Message::TM_REQUEST ) {
			$req = $message[ Message::VALUE ];
			if ( 'GET_PARTITIONS' === $req ) {
				$resp                       = Message::new_message();
				$resp[ Message::TYPE ]      = Message::TM_RESPONSE;
				$resp[ Message::TIMESTAMP ] = Core::$right_now;
				$resp[ Message::FROM ]      = $this->name;
				$resp[ Message::TO ]        = $message[ Message::FROM ];
				$resp[ Message::ID ]        = $message[ Message::ID ];
				$resp[ Message::VALUE ]     = (string) $this->num_partitions;
				$this->sink?->fill( $resp );
			}
			return;
		}

		if ( $type & ( Message::TM_ERROR | Message::TM_EOF ) ) {
			return;
		}

		// Anything else: pick a partition and delegate. Partition::fill packs
		// the message and writes; ack/cancel TM_PERSIST per its contract.
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
}
