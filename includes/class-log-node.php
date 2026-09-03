<?php
/**
 * Log: the append-only segmented log of message VALUEs.
 *
 * A Log writes what the producer sent rather than how the substrate framed it,
 * so the bytes on disk are the producer's own lines. That is the reason the
 * class exists: a Partition's packed envelope is readable only by the substrate,
 * while a Log's segments are what `Tail_Node` streams back and what an operator
 * can open in a pager.
 *
 * It differs from `Partition_Node` at three seams and nowhere else. It
 * serializes the message VALUE instead of the packed envelope; it lays segments
 * out as `{file}.0`, `{file}.1`, … beside the file rather than `{seg}.log`
 * inside a directory of its own, and never writes a bare `{file}`; and its
 * `fill()` drops control messages instead of writing them. Segments, monotonic
 * rotation, the three retention rules, the rotate and write locks,
 * `allow_large_writes()` / `void_warranty()` and the batch/flush path are the
 * parent's, unchanged. Mirrors Tachikoma::Nodes::Log, which writes VALUEs too.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Log node — `make_node Log <name> <file> [segment_size] [min_segments]
 * [num_segments] [max_segments] [min_lifetime] [lifetime]`.
 */
class Log_Node extends Partition_Node {

	/** Resolved log file; segments are {file}.0, {file}.1, … (monotonic, highest = current). */
	protected string $file = '';

	/**
	 * Drop control traffic, write everything else as a data record.
	 *
	 * TM_ERROR, TM_EOF and TM_REQUEST never become log lines. A Log is
	 * append-only, so EOF closes nothing and a write after it must still land;
	 * segmentation is size-driven, so there is no rotate request to honor.
	 * Everything else is a data record, written through the parent's batched
	 * segment path using this class's VALUE `serialize_record()` seam.
	 *
	 * A dropped message still advances `counter`, because the parent counts every
	 * message it is handed and `counter()` reports what the node received rather
	 * than what it wrote.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
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

	/**
	 * VALUE seam: the producer's payload verbatim, with no envelope and no added
	 * newline.
	 *
	 * The record terminator belongs to the producer, which is what lets a Log
	 * hold something other than lines. `Struct_To_JSON_Node` supplies one for a
	 * struct source; a bytestream producer that omits it puts two records on one
	 * line.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @return string The bytes appended for this message.
	 */
	protected function serialize_record( array $message ): string {
		return Core::as_string( $message[ Message::VALUE ] );
	}

	/**
	 * Path seam: segments are siblings of the file, so they live in its parent
	 * directory. `arguments()` validates that directory against the base rather
	 * than `partition_dir`, which a Log never fills.
	 *
	 * @return string Directory holding this Log's segments.
	 */
	protected function segment_dir(): string {
		return \dirname( $this->file );
	}

	/**
	 * Path seam: the data file for one segment, `{file}.{seg}`.
	 *
	 * @param int $segment Segment id.
	 * @return string Path to that segment's data file.
	 * @throws \InvalidArgumentException When the segment id is negative.
	 */
	public function get_segment_path( int $segment ): string {
		if ( $segment < 0 ) {
			throw new \InvalidArgumentException( 'Segment ID must be non-negative' );
		}
		return "{$this->file}.{$segment}";
	}

	/**
	 * Path seam: the companion offset index for one segment, `{file}.{seg}.idx`.
	 *
	 * @param int $segment Segment id.
	 * @return string Path to that segment's index file.
	 */
	protected function get_index_path( int $segment ): string {
		return "{$this->file}.{$segment}.idx";
	}

	/**
	 * Path seam: matches this Log's own data segments within the shared directory.
	 *
	 * The basename is quoted and both ends are anchored, so a sibling Log's
	 * segments, the companion `.idx` files and the two lock directories cannot be
	 * read as segments of this Log. `Log_Sources::source_segments()` builds a
	 * throwaway Log on a path to borrow this rule rather than restate it.
	 *
	 * @return string PCRE whose capture group 1 is the segment id.
	 */
	protected function segment_pattern(): string {
		return '/^' . \preg_quote( \basename( $this->file ), '/' ) . '\.(\d+)$/';
	}

	/**
	 * Path seam: the mkdir-lock serializing multi-writer rotation, `{file}.rotate.lock.d`.
	 *
	 * Keyed by the file, not by the directory the parent uses: a directory holds
	 * exactly one Partition but any number of Logs, so a directory-named lock
	 * would make unrelated Logs wait on each other's rotations.
	 *
	 * @return string Lock directory path.
	 */
	protected function rotate_lock_path(): string {
		return "{$this->file}.rotate.lock.d";
	}

	/**
	 * Path seam: the per-writer exclusivity lock `allow_large_writes()` takes,
	 * `{file}.write.lock.d` — keyed by the file, since sibling Logs share a
	 * directory.
	 *
	 * @return string Lock directory path.
	 */
	protected function write_lock_path(): string {
		return "{$this->file}.write.lock.d";
	}

	/**
	 * Path seam: the writer identity behind the write-stall quarantine directory.
	 * Sibling Logs share a directory, so the FILE keys the quarantine and two
	 * Logs cannot quarantine into each other.
	 *
	 * @return string Path identifying this writer.
	 */
	protected function write_quarantine_key(): string {
		return $this->file;
	}

	/**
	 * Topology console manifest: the required `file` positional in front of the
	 * parent's retention knobs. The parent merge supplies the `I/O` category, the
	 * `allow_large_writes` / `void_warranty` verbs and `has_target => false`.
	 * Declaring the arguments here is the whole parse — ADR-11 puts defaults and
	 * coercion in `parse_schema_args()`, not in `arguments()`.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'description' => 'Append-only segmented log of message VALUEs ({file}.{seg}).',
			'arguments'   => [
				[ 'name' => 'file',         'type' => 'string', 'required' => true, 'description' => 'Log file path; segments are written alongside it as {file}.0, {file}.1, … (highest suffix = current).' ],
				[ 'name' => 'segment_size', 'type' => 'int',    'default' => '<config:segment_size>', 'description' => 'Segment rotation threshold in bytes; a new segment starts once a write would exceed it (default 64 MiB).' ],
				[ 'name' => 'min_segments', 'type' => 'int',    'default' => '<config:min_segments>', 'description' => 'Age-rule floor: keep at least this many segments (clamped to a hard minimum of 2).' ],
				[ 'name' => 'num_segments', 'type' => 'int',    'default' => '<config:num_segments>', 'description' => 'Count-rule target: prune the oldest back to this many segments, but only ones older than min_lifetime.' ],
				[ 'name' => 'max_segments', 'type' => 'int',    'default' => '<config:max_segments>', 'description' => 'True hard cap: prune the oldest UNCONDITIONALLY above this many segments (min_lifetime does not protect them). 0 = derive as 2 × num_segments.' ],
				[ 'name' => 'min_lifetime', 'type' => 'int',    'default' => '<config:min_lifetime>', 'description' => 'Count-rule floor: keep segments younger than this many seconds even when over num_segments; 0 keeps nothing extra.' ],
				[ 'name' => 'lifetime',     'type' => 'int',    'default' => '<config:lifetime>', 'description' => 'Age rule: prune segments older than this many seconds down to min_segments; 0 disables age-based pruning.' ],
			],
		] );
	}
}
