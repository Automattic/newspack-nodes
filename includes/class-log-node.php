<?php
/**
 * Log: append-only segmented log of message VALUEs.
 *
 * A Log is a Partition that (1) writes the message VALUE (the producer's
 * payload) instead of the whole packed envelope, and (2) lays segments out as
 * {file}.{seg} (a file with monotonic numeric suffixes) instead of {dir}/{seg}.log.
 * Everything else — segments, monotonic rotation, count/age retention, the
 * multi-writer rotate lock, allow_large_writes()/void_warranty(), batch/flush —
 * is inherited from Partition_Node. Mirrors Tachikoma::Nodes::Log writing VALUEs.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Log_Node extends Partition_Node {

	/** Resolved log file; segments are {file}.0, {file}.1, … (monotonic, highest = current). */
	protected string $file = '';

	/**
	 * Control messages don't become log lines: TM_ERROR / TM_EOF / TM_REQUEST are
	 * dropped (Log is append-only — EOF never closes it; segmentation is
	 * size-driven, so there is no rotate request). Everything else is a data
	 * record written via the parent's batched segment path using this class's
	 * VALUE serialize_record seam.
	 *
	 * @param array<int, mixed> $message
	 */
	public function fill( array $message ): void {
		$type_raw = $message[ Message::TYPE ];
		$type     = Core::num_int( $type_raw );

		if ( $type & ( Message::TM_ERROR | Message::TM_EOF | Message::TM_REQUEST ) ) {
			++$this->counter;
			return;
		}

		parent::fill( $message );
	}

	/** VALUE seam: write the producer's payload verbatim (no envelope, no added newline). */
	protected function serialize_record( array $message ): string {
		return Core::as_string( $message[ Message::VALUE ] );
	}

	/** Path seam: segments are siblings of the file, suffixed with the segment id. */
	protected function segment_dir(): string {
		return \dirname( $this->file );
	}

	public function get_segment_path( int $segment ): string {
		if ( $segment < 0 ) {
			throw new \InvalidArgumentException( 'Segment ID must be non-negative' );
		}
		return "{$this->file}.{$segment}";
	}

	protected function get_index_path( int $segment ): string {
		return "{$this->file}.{$segment}.idx";
	}

	protected function segment_pattern(): string {
		return '/^' . \preg_quote( \basename( $this->file ), '/' ) . '\.(\d+)$/';
	}

	protected function rotate_lock_path(): string {
		return "{$this->file}.rotate.lock.d";
	}

	protected function write_lock_path(): string {
		return "{$this->file}.write.lock.d";
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'description' => 'Append-only segmented log of message VALUEs ({file}.{seg}).',
			'arguments'   => [
				[ 'name' => 'file',         'type' => 'string', 'required' => true, 'description' => 'Log file path; segments are written alongside it as {file}.0, {file}.1, … (highest suffix = current).' ],
				[ 'name' => 'segment_size', 'type' => 'int',    'default' => self::DEFAULT_SEGMENT_SIZE, 'description' => 'Segment rotation threshold in bytes; a new segment starts once a write would exceed it (default 64 MiB).' ],
				[ 'name' => 'num_segments', 'type' => 'int',    'default' => self::DEFAULT_NUM_SEGMENTS, 'description' => 'Max segments kept before the oldest is pruned (retention count; clamped to a minimum of 2).' ],
			],
		] );
	}
}
