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

	protected function partition( int $i ): Partition {
		if ( ! isset( $this->partitions[ $i ] ) ) {
			$this->partitions[ $i ] = new Partition(
				$this->base_dir, $i,
				$this->segment_size, $this->num_segments, $this->max_lifespan
			);
		}
		return $this->partitions[ $i ];
	}

	public function write( string $key, string $value ): bool {
		if ( $key !== '' ) {
			$idx = Partition::hash_to_partition( $key, $this->num_partitions );
		} else {
			$idx = ( self::$rr_counter++ ) % $this->num_partitions;
		}
		return $this->partition( $idx )->write( $value );
	}

	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];

		if ( $type & Message::TM_BYTESTREAM ) {
			// Pre-pinned via TO: parse partition index out of TO's leading segment.
			if ( $message[ Message::TO ] !== '' && \preg_match( '/^p(\d+)/', $message[ Message::TO ], $m ) ) {
				$idx = (int) $m[1];
				if ( $idx >= 0 && $idx < $this->num_partitions ) {
					$this->partition( $idx )->write( $message[ Message::VALUE ] );
					if ( $type & Message::TM_PERSIST ) {
						$this->answer( $message );
					}
					return;
				}
			}
			// KEY-routed (or round-robin if KEY empty).
			$this->write( $message[ Message::KEY ], $message[ Message::VALUE ] );
			if ( $type & Message::TM_PERSIST ) {
				$this->answer( $message );
			}
			return;
		}

		if ( $type & Message::TM_REQUEST ) {
			$req = $message[ Message::VALUE ];
			if ( $req === 'GET_PARTITIONS' ) {
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
	}
}
