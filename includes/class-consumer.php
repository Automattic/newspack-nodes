<?php
/**
 * Consumer: Partition-aware reader with offsetlog checkpointing.
 *
 * Generalizes existing LogReader. Reads new entries from a Partition's segment
 * series; commits {seg, off} to its offsetlog (which is itself a single-partition
 * Partition under offsets/{reader}/p0/) on checkpoint.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Consumer extends Timer {
	/** Hard cap on the cross-poll trailing-line buffer. 20MB. */
	public const MAX_LINE_BUFFER_SIZE = 20971520;

	/** Stale-segment threshold: skip corrupt unread bytes only after this many seconds. */
	public const STALE_SEGMENT_SECONDS = 5;

	/** Re-arm interval at EOF (idle backoff). */
	public const POLL_INTERVAL_EOF_MS = 100;

	/** Re-arm interval when there's data to drain. 0 = next event-loop iteration. */
	public const POLL_INTERVAL_BUSY_MS = 0;

	protected string $source_base_dir;
	protected int $source_partition;
	protected string $offsetlog_dir;
	protected Partition $source;
	protected Partition $offsetlog;

	/**
	 * Cursor segment. Bytes up to (but not including) cursor_off + line_remainder
	 * length have been read from this segment. cursor_off + line_remainder.length
	 * is the next read position.
	 */
	protected int $cursor_seg = 0;

	/**
	 * Last byte offset COMMITTED to the offsetlog for cursor_seg. cursor_off always
	 * lands on a line boundary — never mid-line. Trailing partial bytes live in
	 * $line_remainder until a future poll completes them with a newline.
	 */
	protected int $cursor_off = 0;

	/**
	 * Trailing partial line read past cursor_off but not yet emitted.
	 * Bytes here have been READ from the source but their offset has NOT been
	 * committed to cursor_off. The next poll prepends this to its read so a
	 * line split across PIPE_BUF boundaries gets emitted intact.
	 */
	protected string $line_remainder = '';

	/** True once the newest segment's tail has been consumed. */
	protected bool $at_eof = true;

	public function __construct(
		string $source_base_dir,
		int $source_partition,
		string $offsetlog_base_dir
	) {
		parent::__construct();
		$this->source_base_dir  = \rtrim( $source_base_dir, '/' );
		$this->source_partition = $source_partition;
		$this->offsetlog_dir    = \rtrim( $offsetlog_base_dir, '/' );

		$this->source    = new Partition( $this->source_base_dir, $this->source_partition );
		$this->offsetlog = new Partition( $this->offsetlog_dir, 0 );
		$this->offsetlog->allow_large_writes(); // Offsetlog entries with large state can exceed 4KB.

		$this->load_offsetlog();

		// Start polling immediately. fire() re-arms with set_timer(0)/(100)
		// based on whether new bytes are available.
		$this->set_timer( self::POLL_INTERVAL_EOF_MS, true );
	}

	/**
	 * Read the newest offsetlog entry to seed the cursor.
	 * Format: JSONL with {seg, off, ts}.
	 */
	protected function load_offsetlog(): void {
		$segments = $this->offsetlog->get_segments( true );
		if ( empty( $segments ) ) {
			return;
		}
		$newest = \end( $segments );
		$bytes  = $this->offsetlog->read_at( $newest['id'], 0, $newest['size'] );
		$lines  = \array_filter( \explode( "\n", $bytes ), static fn ( $l ) => $l !== '' );
		if ( empty( $lines ) ) {
			return;
		}
		$last = \json_decode( \end( $lines ), true );
		if ( \is_array( $last ) && isset( $last['seg'], $last['off'] ) ) {
			$this->cursor_seg = (int) $last['seg'];
			$this->cursor_off = (int) $last['off'];
		}
	}

	/**
	 * Set next read position. Mirrors FirehoseReader::next_offset:
	 *   - 'start':  segment 0 / offset 0
	 *   - 'recent': start of second-to-last segment (oldest if only one)
	 *   - 'end':    tail of newest segment
	 *   - array{seg:int,off:int}: explicit position
	 *
	 * Used by SSE/tail callers that want to skip historical data.
	 *
	 * @param string|array $position Magic value or explicit position.
	 */
	public function next_offset( $position ): void {
		$this->line_remainder = '';
		$this->at_eof         = false;

		if ( \is_array( $position ) ) {
			$this->cursor_seg = (int) ( $position['seg'] ?? 0 );
			$this->cursor_off = \max( 0, (int) ( $position['off'] ?? 0 ) );
			return;
		}

		$segments = $this->source->get_segments( true );

		switch ( $position ) {
			case 'end':
				if ( ! empty( $segments ) ) {
					$newest           = \end( $segments );
					$this->cursor_seg = $newest['id'];
					$this->cursor_off = $newest['size'];
				}
				break;

			case 'recent':
				if ( ! empty( $segments ) ) {
					$count = \count( $segments );
					if ( $count >= 2 ) {
						$this->cursor_seg = $segments[ $count - 2 ]['id'];
					} else {
						$this->cursor_seg = $segments[0]['id'];
					}
					$this->cursor_off = 0;
				}
				break;

			case 'start':
			default:
				$this->cursor_seg = 0;
				$this->cursor_off = 0;
				break;
		}
	}

	/**
	 * Force-mark caught up. Used by callers driving fgets() directly instead of poll().
	 */
	public function mark_eof(): void {
		$this->at_eof = true;
	}

	/**
	 * True if the last poll ran the newest segment to its end.
	 *
	 * SSE callers use this to decide when to sleep instead of busy-looping.
	 * Uses the cached segments list (SEGMENT_CACHE_TTL = 250ms) so frequent
	 * calls don't thrash the filesystem.
	 */
	public function is_caught_up(): bool {
		if ( ! $this->at_eof ) {
			return false;
		}
		\clearstatcache( true, $this->source->partition_dir() );
		$segments = $this->source->get_segments( true );
		if ( empty( $segments ) ) {
			return true;
		}
		$newest = \end( $segments );
		// Caught up if our cursor (plus any uncommitted remainder bytes) has
		// reached the newest segment's tail.
		if ( $this->cursor_seg < $newest['id'] ) {
			return false;
		}
		$tail = $this->cursor_off + \strlen( $this->line_remainder );
		return $tail >= $newest['size'];
	}

	/**
	 * Sync the in-memory cursor offset from a caller's external read.
	 * Used by fgets()-direct callers — they advance their own ftell() and tell us
	 * how many bytes they consumed since our last commit.
	 *
	 * @param int $bytes_consumed Bytes consumed beyond the current cursor_off.
	 */
	public function update_offset( int $bytes_consumed ): void {
		if ( $bytes_consumed < 0 ) {
			return;
		}
		$this->cursor_off += $bytes_consumed;
	}

	/**
	 * Open the source partition and resync if our cursor segment was deleted.
	 *
	 * Returns the segment we'll read from on next poll. Used by callers that want
	 * to verify the cursor is positioned on a live segment before reading.
	 *
	 * @return array{id:int,size:int}|null Current segment metadata or null if no segments exist.
	 */
	public function open(): ?array {
		\clearstatcache( true, $this->source->partition_dir() );
		$segments = $this->source->get_segments( true );
		if ( empty( $segments ) ) {
			return null;
		}
		$found = null;
		foreach ( $segments as $s ) {
			if ( $s['id'] === $this->cursor_seg ) {
				$found = $s;
				break;
			}
		}
		if ( null === $found ) {
			// Cursor segment was deleted (cleanup_segments). Jump to oldest available
			// and resync the offset to 0.
			$found                = $segments[0];
			$this->cursor_seg     = $found['id'];
			$this->cursor_off     = 0;
			$this->line_remainder = '';
		}
		return $found;
	}

	/**
	 * Move past the current segment when its writer has gone stale.
	 *
	 * Logic mirrors FirehoseReader::next_segment:
	 *   - If next id missing AND current id missing → firehose was wiped; jump to oldest.
	 *   - If current segment was modified within STALE_SEGMENT_SECONDS, stay (writer alive).
	 *   - Otherwise advance to the next id.
	 *
	 * @return int|null New cursor segment id, or null if there's nothing to advance to.
	 */
	public function next_segment(): ?int {
		\clearstatcache( true, $this->source->partition_dir() );
		$segments = $this->source->get_segments( true );
		if ( empty( $segments ) ) {
			return null;
		}

		$ids       = \array_column( $segments, 'id' );
		$next_id   = $this->cursor_seg + 1;
		$has_next  = \in_array( $next_id, $ids, true );
		$has_curr  = \in_array( $this->cursor_seg, $ids, true );

		if ( ! $has_next && ! $has_curr ) {
			// Both gone: firehose was reset. Jump to oldest.
			$this->cursor_seg     = $segments[0]['id'];
			$this->cursor_off     = 0;
			$this->line_remainder = '';
			return $this->cursor_seg;
		}

		if ( $has_curr ) {
			$current_path = "{$this->source->partition_dir()}/{$this->cursor_seg}.log";
			\clearstatcache( true, $current_path );
			$mtime = @\filemtime( $current_path );
			$stale = $mtime ? ( \time() - $mtime ) : PHP_INT_MAX;
			if ( $stale < self::STALE_SEGMENT_SECONDS ) {
				// Writer is still active on this segment. Don't advance.
				return null;
			}
		}

		if ( ! $has_next ) {
			return null;
		}

		$this->cursor_seg     = $next_id;
		$this->cursor_off     = 0;
		$this->line_remainder = '';
		return $next_id;
	}

	/**
	 * Read new bytes since the last cursor; emit a TM_BYTESTREAM per complete line; advance cursor.
	 *
	 * Trailing partial lines are carried across poll boundaries via $line_remainder so a
	 * line split mid-buffer (e.g. by a writer's PIPE_BUF boundary or a slow producer)
	 * gets emitted intact on the next poll. Cursor commits ONLY at line boundaries.
	 *
	 * KEY = "{seg}:{offset}" so the offsetlog can checkpoint by segment+offset.
	 */
	public function poll(): void {
		// Defeat PHP's stat cache so size growth from a writer in another process is visible.
		\clearstatcache( true, $this->source->partition_dir() );
		$segments = $this->source->get_segments( true );
		if ( empty( $segments ) ) {
			$this->at_eof = true;
			return;
		}

		// If the cursor segment is gone (deleted by cleanup), recover via open().
		$ids = \array_column( $segments, 'id' );
		if ( ! \in_array( $this->cursor_seg, $ids, true ) ) {
			$this->cursor_seg     = $segments[0]['id'];
			$this->cursor_off     = 0;
			$this->line_remainder = '';
		}

		$newest_id   = \end( $segments )['id'];
		$newest_size = \end( $segments )['size'];

		foreach ( $segments as $s ) {
			if ( $s['id'] < $this->cursor_seg ) {
				continue;
			}

			// Crossing into a new segment: drop any line_remainder from the prior segment
			// (it would have been emitted as a partial line; let it die here) and reset
			// the cursor onto the new segment.
			if ( $s['id'] !== $this->cursor_seg ) {
				$this->cursor_seg     = $s['id'];
				$this->cursor_off     = 0;
				$this->line_remainder = '';
			}

			// Read past whatever's already in line_remainder. Read offset = cursor_off
			// + remainder.length (= total bytes already consumed FROM THIS SEGMENT).
			$remainder_len = \strlen( $this->line_remainder );
			$read_start    = $this->cursor_off + $remainder_len;
			$len           = $s['size'] - $read_start;

			// Cap per-poll read at Partition::MAX_READ_SIZE so giant segments drain across polls.
			if ( $len > Partition::MAX_READ_SIZE ) {
				$len = Partition::MAX_READ_SIZE;
			}

			if ( $len <= 0 && $remainder_len === 0 ) {
				continue;
			}

			$bytes = ( $len > 0 ) ? $this->source->read_at( $s['id'], $read_start, $len ) : '';

			// DoS guard: reject if buffer would exceed MAX_LINE_BUFFER_SIZE.
			if ( $remainder_len + \strlen( $bytes ) > self::MAX_LINE_BUFFER_SIZE ) {
				Core::print_less_often(
					\sprintf(
						'Consumer: line buffer exceeded %d bytes at seg %d off %d - discarding',
						self::MAX_LINE_BUFFER_SIZE,
						$s['id'],
						$read_start
					)
				);
				// Discard remainder + advance cursor past everything we've read in this poll.
				// remainder bytes were beyond cursor_off; we now sweep cursor_off past them
				// and past the bytes just fetched so subsequent polls don't re-read them.
				$this->line_remainder = '';
				$this->cursor_seg     = $s['id'];
				$nl                   = \strpos( $bytes, "\n" );
				if ( false !== $nl ) {
					// Land cursor immediately after the newline; carry the bytes after the
					// newline as the new remainder (they may complete on a future poll).
					$this->cursor_off     = $read_start + $nl + 1;
					$tail                 = \substr( $bytes, $nl + 1 );
					$this->line_remainder = $tail;
				} else {
					// No newline at all — sweep cursor past everything we've read.
					$this->cursor_off = $read_start + \strlen( $bytes );
				}
				continue;
			}

			$buffer = $this->line_remainder . $bytes;
			$lines  = \explode( "\n", $buffer );
			// array_pop removes the trailing partial (will be empty if buffer ended with \n).
			$pending = (string) \array_pop( $lines );

			// Each emitted line's absolute offset within the source segment:
			// cursor_off + (cumulative bytes of prior emitted lines in $buffer).
			$offset_in_buffer = 0;
			foreach ( $lines as $line ) {
				$abs_offset = $this->cursor_off + $offset_in_buffer;

				$msg                       = Message::new_message();
				$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
				$msg[ Message::TIMESTAMP ] = Core::$right_now;
				$msg[ Message::FROM ]      = $this->name;
				$msg[ Message::KEY ]       = "{$s['id']}:{$abs_offset}";
				$msg[ Message::VALUE ]     = $line . "\n";
				$this->sink?->fill( $msg );

				$offset_in_buffer += \strlen( $line ) + 1; // +1 for the consumed \n.
			}

			// Commit cursor past all emitted lines. Trailing partial bytes are NOT
			// reflected in cursor_off — they survive in $line_remainder for the next poll.
			$this->cursor_seg     = $s['id'];
			$this->cursor_off    += $offset_in_buffer;
			$this->line_remainder = $pending;
		}

		$tail_after_remainder = $this->cursor_off + \strlen( $this->line_remainder );
		$this->at_eof         = ( $this->cursor_seg >= $newest_id ) && ( $tail_after_remainder >= $newest_size );
	}

	/**
	 * Append a {seg, off, ts} JSONL entry to the offsetlog so a future Consumer instance can resume.
	 */
	public function checkpoint(): void {
		$entry = \json_encode(
			[
				'seg' => $this->cursor_seg,
				'off' => $this->cursor_off,
				'ts'  => Core::$right_now,
			]
		);
		$this->offsetlog->write( $entry . "\n" );
	}

	/**
	 * Consumer is Timer-driven: each fire() polls the source Partition for new
	 * bytes, emits per-line, and re-arms with set_timer(0) (busy — drain ASAP)
	 * or set_timer(100) (EOF — back off to 100ms idle ticks). Spec instruction
	 * matches Tail.pm's poll_timer pattern, simplified to one timer per Consumer.
	 */
	protected function fire(): void {
		$this->poll();
		$next_ms = $this->at_eof ? self::POLL_INTERVAL_EOF_MS : self::POLL_INTERVAL_BUSY_MS;
		$this->set_timer( $next_ms, true ); // oneshot — fire() re-arms.
	}
}
