<?php
/**
 * File_Tail: follows a SINGLE filename with `tail -F` logrotate semantics.
 *
 * A subclass of segmented `Tail` rather than a mode flag on it: the two share
 * the Durable_Reader line-assembly spine and the durable offsetlog cursor, and
 * differ only in the byte source. Within a run this reader holds the open
 * handle, drains a rotated-away generation to EOF before reopening the path
 * from 0, resets on in-place truncation, and tolerates a missing path.
 *
 * The cursor shape is the inherited one — the inode occupies the container slot
 * where a segment id sits, so `<inode>:<offset>:<length>` rides the existing
 * offsetlog frame and DLQ machinery with no new field. A resume validates the
 * persisted cursor against the current file: a foreign, zero or absent
 * generation reads it whole, and a mid-line offset in the RIGHT generation
 * syncs forward onto the next newline — never cross-generation hunting.
 *
 * `compute_lag()` is the ONE substituted seam. `GET_LAG`, `probe_stats()` and
 * `idle_since()` all read it, so the request reply, the probe record and the
 * idle check cannot answer the same question three ways.
 *
 * This class has no source Partition — a single inode is not a segment list —
 * so `source()` refuses by name instead of failing as an init error.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class File_Tail_Node extends Tail_Node {

	/**
	 * The open read handle for the currently-followed generation, or null when
	 * none is open — the path is absent, unreadable, or not yet opened. A
	 * rotated-away generation stays open here until drained to EOF. Its inode
	 * lives in the inherited $cursor_segment; 0 = no open container.
	 *
	 * @var resource|null
	 */
	protected $follow_handle = null;

	/**
	 * An explicit array-form next_offset() seek {inode, offset} made BEFORE the
	 * file opens (build time), awaiting validation on the first poll once the
	 * live inode is known. A runtime seek (handle already open) validates
	 * immediately and leaves this null. A null `inode` names no generation, so
	 * its offset says nothing about this file: read it whole.
	 *
	 * @var array{inode:int|null,offset:int}|null
	 */
	private ?array $file_seek_candidate = null;

	/**
	 * Set when the seated cursor is NOT a line boundary. The bytes up to the
	 * next newline are the tail of a line this reader never saw the start of,
	 * so they are dropped rather than emitted as though they were a line.
	 */
	private bool $pending_line_sync = false;

	/**
	 * Store the token array, then arm the reader. There is no source Partition —
	 * the segment model cannot identify a single inode — so the shared
	 * Durable_Reader spine is armed directly.
	 *
	 * `source_file` is deliberately NOT passed through
	 * `Config::assert_within_base()` the way Consumer's `source_dir` is: following
	 * a log the substrate does not own is the whole point, and `Log_Sources`
	 * registers php's `error_log` and `wp-content/debug.log`. The confinement
	 * lands on the offsetlog instead, whose sidecar Partition asserts it when
	 * `ensure_offsetlog()` builds it.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		$this->ensure_offsetlog();
		$this->ensure_deadletter();
		// No I/O at construction; first poll opens + seats the cursor (ADR-5).
		$this->poll_cb = $this->poll_init( ... );
		$this->set_timer( self::POLL_INTERVAL_EOF_MS );
		$this->set_state( 'POLLING', 'ACTIVE' );
		return $args;
	}

	/** Refill seam: read the followed inode, not a Partition segment. */
	protected function get_batch(): void {
		$this->get_file_batch();
	}

	/**
	 * File-mode refill (one block per tick, yielding the event loop). First drains
	 * the currently open generation — reading appended bytes, resetting on an
	 * in-place truncation. Only once that handle is at EOF does it consult the
	 * PATH: a same-inode path means caught up, a missing path is a rotation gap
	 * (keep polling), and a different inode is a rotation — the drained old handle
	 * closes and the new generation opens at offset 0. Draining before switching is
	 * what guarantees a rotated file's tail-end emits before the new file's first
	 * line.
	 *
	 * With no handle open — the path was absent when `init_position()` ran — there
	 * is nothing to drain, so the path check alone decides and opens the
	 * generation the moment the file appears.
	 */
	private function get_file_batch(): void {
		$path = $this->source_file;
		\clearstatcache( true, $path );
		if ( null !== $this->follow_handle ) {
			$read_pos = $this->cursor_offset + \strlen( $this->buffer );
			$stat     = \fstat( $this->follow_handle );
			$size     = false === $stat ? 0 : $stat['size'];
			if ( $size < $read_pos ) {
				// Truncated in place (copytruncate): reset to the new start.
				$this->cursor_offset     = 0;
				$this->buffer            = '';
				$read_pos                = 0;
				$this->pending_line_sync = false;
			}
			$available = $size - $read_pos;
			if ( $available > 0 ) {
				$length = \min( self::READ_BLOCK_BYTES, $available );
				\fseek( $this->follow_handle, $read_pos );
				// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fread
				$bytes = \fread( $this->follow_handle, $length );
				if ( \is_string( $bytes ) && '' !== $bytes ) {
					$this->buffer     .= $bytes;
					$this->bytes_read += \strlen( $bytes );
					$this->at_eof      = false;
					$this->drop_partial_line();
					return;
				}
			}
			// Open generation drained; fall through to the rotation check.
		}

		$path_inode = $this->path_stat()['ino'] ?? 0;

		if ( null !== $this->follow_handle && 0 !== $path_inode && $path_inode === $this->cursor_segment ) {
			$this->at_eof = ! $this->buffer_holds_line();
			return;
		}
		if ( 0 === $path_inode ) {
			// Path missing (rotation gap): keep polling, not an error.
			$this->at_eof = ! $this->buffer_holds_line();
			return;
		}
		// New generation: drop any partial last line, then reset the cursor.
		$this->buffer = '';
		if ( $this->open_generation( $path ) ) {
			$this->cursor_offset     = 0;
			$this->at_eof            = false;
			$this->pending_line_sync = false;
			return;
		}
		// Reappeared then vanished (race): treat as missing and poll again.
		$this->at_eof = true;
	}

	/**
	 * Boot seam: open the current generation (its inode into $cursor_segment),
	 * then seat the byte cursor with Consumer's precedence — durable-resume-wins:
	 *   1. a durable offsetlog frame (its `segment` slot is the stored inode), validated;
	 *   2. else an explicit build-time next_offset() hint — an array {inode,offset} seek is
	 *      validated the SAME way, a magic 'start'/'end' seek already seated cursor_offset;
	 *   3. else default to END.
	 * A build-time hint must LOSE to a durable checkpoint, or every respawn re-reads the whole file.
	 */
	protected function init_position(): void {
		$this->open_generation( $this->source_file );
		$frame = $this->read_last_offsetlog_frame();
		if ( null !== $frame && isset( $frame['segment'], $frame['offset'] ) ) {
			$this->cursor_offset       = $this->validate_resume_offset( Core::num_int( $frame['segment'] ), Core::num_int( $frame['offset'] ) );
			$this->file_seek_candidate = null;
			return;
		}
		if ( $this->offset_set ) {
			if ( null !== $this->file_seek_candidate ) {
				$this->cursor_offset       = $this->validate_resume_offset( $this->file_seek_candidate['inode'], $this->file_seek_candidate['offset'] );
				$this->file_seek_candidate = null;
			}
			return;
		}
		$this->next_offset( 'end' );
	}

	/**
	 * Reposition the read cursor. There are no segments: SEEK_END is the file size, SEEK_START and
	 * SEEK_RECENT are 0 (one file has no previous segment to fall back to), and an explicit array
	 * {segment: inode, offset} is a RESUME CANDIDATE validated through the same
	 * validate_resume_offset() path as a durable frame (a foreign/absent generation or a shrunk
	 * file reads from 0; a mid-line offset syncs forward). A runtime seek (handle already open)
	 * validates now; a build-time one defers to the first poll.
	 *
	 * @param string|int|array<array-key,mixed> $position Seek sentinel, alias word, or explicit {segment,offset}.
	 */
	public function next_offset( $position ): void {
		$this->offset_set          = true;
		$this->buffer              = '';
		$this->at_eof              = false;
		$this->file_seek_candidate = null;
		$this->pending_line_sync   = false;
		if ( \is_array( $position ) ) {
			// A missing key names NO generation; 0 would name a closed handle.
			$inode  = isset( $position['segment'] ) ? Core::num_int( $position['segment'] ) : null;
			$offset = \max( 0, Core::num_int( $position['offset'] ?? 0 ) );
			if ( null !== $this->follow_handle ) {
				$this->cursor_offset = $this->validate_resume_offset( $inode, $offset );
			} else {
				$this->file_seek_candidate = [ 'inode' => $inode, 'offset' => $offset ];
			}
			return;
		}
		if ( 'end' !== $position && self::SEEK_END !== $position ) {
			$this->cursor_offset = 0;
			return;
		}
		// EOF on a live log is mid-line as often as not; sync, don't ship it.
		$this->cursor_offset     = $this->file_current_size();
		$this->pending_line_sync = $this->cursor_offset > 0
			&& "\n" !== $this->read_byte_at( $this->cursor_offset - 1 );
	}

	/**
	 * One followed path, so its own mtime is the answer — the parent's
	 * newest-segment walk has no segment list to walk.
	 *
	 * Null means "not idle", which is what an absent path reports: a rotation gap
	 * is a moment between generations, not a stream nobody writes, and hanging up
	 * on one would drop the reader before the new file appears.
	 *
	 * @return float|null Epoch seconds the followed file last grew, or null while
	 *                    the path is absent or bytes are still unread.
	 */
	public function idle_since(): ?float {
		$stat = $this->path_stat();
		if ( null === $stat || ! $this->compute_lag()['caught_up'] ) {
			return null;
		}
		return (float) $stat['mtime'];
	}

	/**
	 * Lag seam: file size − read position, with no segments behind. The inode
	 * rides `end_segment` exactly as it rides `cursor_segment`, so the probe
	 * record and the GET_LAG reply name the same generation.
	 *
	 * The buffered-but-unemitted bytes count as READ — a reader holding a
	 * partial line has consumed it — so `bytes_behind` here is what the probe's
	 * DISTANCE reports, one definition for both.
	 *
	 * @return array{bytes_behind:int,segments_behind:int,caught_up:bool,end_segment:int,end_size:int,end_bytes:int,cursor_segment:int,cursor_offset:int}
	 */
	protected function compute_lag(): array {
		$size         = $this->file_current_size();
		$bytes_behind = \max( 0, $size - ( $this->lag_cursor_offset() + \strlen( $this->buffer ) ) );
		return [
			'bytes_behind'    => $bytes_behind,
			'segments_behind' => 0,
			'caught_up'       => 0 === $bytes_behind,
			'end_segment'     => $this->cursor_segment,
			'end_size'        => $size,
			'end_bytes'       => $size,
			'cursor_segment'  => $this->cursor_segment,
			'cursor_offset'   => $this->cursor_offset,
		];
	}

	/**
	 * Always name the generation this offset belongs to.
	 *
	 * The inode reaches cursor_segment only when the handle opens on the first
	 * poll, and a stream that seeks to EOF and hangs up never polls — so ask
	 * the path, which next_offset() already stats for its size. An unnamed
	 * generation would be indistinguishable from a foreign one, reading the whole
	 * file back on every reconnect. The offset is named even when it is mid-line;
	 * the resume syncs forward from there.
	 *
	 * @return string `{inode}:{offset}`, or `:{offset}` when no generation is named.
	 */
	public function cursor_position(): string {
		// A candidate's offset belongs to the generation the CLIENT named.
		if ( null !== $this->file_seek_candidate ) {
			$inode = $this->file_seek_candidate['inode'] ?? 0;
			return ( 0 === $inode ? '' : (string) $inode ) . ':'
				. $this->file_seek_candidate['offset'];
		}
		// Fall back to the path: next_offset('end') sized that same file.
		$inode = 0 !== $this->cursor_segment
			? $this->cursor_segment
			: $this->file_current_inode();
		return ( 0 === $inode ? '' : (string) $inode ) . ':' . $this->cursor_offset;
	}

	/**
	 * Close the follow handle before the base teardown. Nothing in the sibling
	 * cascade knows about an fopen handle, so a torn-down reader would otherwise
	 * hold the descriptor for the rest of the worker's life.
	 */
	public function remove_node(): void {
		$this->close_follow_handle();
		parent::remove_node();
	}

	/**
	 * Open `$path` as the current generation: close whatever was open, fopen,
	 * and put the new inode in the container slot. False when the path is
	 * absent or unreadable, leaving the slot at 0.
	 *
	 * ONE open sequence for both callers — the boot seat and the rotation
	 * switch, which differ only in the cursor reset each owns.
	 */
	private function open_generation( string $path ): bool {
		$this->close_follow_handle();
		$this->cursor_segment = 0;
		if ( '' === $path ) {
			return false;
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
		$handle = @\fopen( $path, 'rb' );
		if ( false === $handle ) {
			return false;
		}
		$this->follow_handle  = $handle;
		$stat                 = \fstat( $handle );
		$this->cursor_segment = false === $stat ? 0 : $stat['ino'];
		return true;
	}

	/** Release the open generation's descriptor. Idempotent: no handle, no-op. */
	private function close_follow_handle(): void {
		if ( null !== $this->follow_handle ) {
			\fclose( $this->follow_handle );
			$this->follow_handle = null;
		}
	}

	/**
	 * Validate a persisted cursor against the CURRENT file and return the offset to
	 * resume at. The frame's container slot is the stored inode. The current file
	 * is read from 0, never hunted across generations, whenever the stored
	 * generation is absent, zero or foreign, the file shrank below the cursor, or
	 * nothing is open here to validate against. A cursor in the RIGHT generation
	 * that is not just past a newline is mid-line: resume there and sync forward
	 * onto the next one. cursor == size (the file ends exactly on
	 * the last emitted newline) is valid and reads nothing until it grows.
	 *
	 * @param int|null $stored_inode Generation the cursor was recorded against; null when unnamed.
	 * @param int      $cursor       Persisted byte offset within that generation.
	 * @return int The offset to resume at: `$cursor`, or 0 to read the file whole.
	 */
	private function validate_resume_offset( ?int $stored_inode, int $cursor ): int {
		// Offset 0 IS a boundary; a flag left armed would eat the first line.
		$this->pending_line_sync = false;
		if ( $cursor <= 0 || 0 === $this->cursor_segment ) {
			return 0;
		}
		// Another file's offset means nothing here: read this one whole.
		if ( null === $stored_inode || 0 === $stored_inode
			|| $stored_inode !== $this->cursor_segment ) {
			return 0;
		}
		if ( $this->file_current_size() < $cursor ) {
			return 0;
		}
		if ( "\n" === $this->read_byte_at( $cursor - 1 ) ) {
			return $cursor;
		}
		// Right generation, mid-line: resume and sync onto the next newline.
		$this->pending_line_sync = true;
		return $cursor;
	}

	/**
	 * Discard the buffered fragment that precedes the first newline, once.
	 *
	 * Advancing cursor_offset by what is dropped keeps it the file position of
	 * buffer[0], which is what the next read_pos and every emitted line offset
	 * are computed from. Until the newline arrives there is nothing to sync on,
	 * so the fragment simply keeps buffering and nothing is emitted.
	 */
	private function drop_partial_line(): void {
		if ( ! $this->pending_line_sync ) {
			return;
		}
		$nl = \strpos( $this->buffer, "\n" );
		if ( false === $nl ) {
			return;
		}
		$this->cursor_offset    += $nl + 1;
		$this->buffer            = \substr( $this->buffer, $nl + 1 );
		$this->pending_line_sync = false;
	}

	/**
	 * Whether the buffer already holds a complete line. Durable_Reader's
	 * `buffer_has_line()` is private, so it does not reach a subclass.
	 */
	private function buffer_holds_line(): bool {
		return false !== \strpos( $this->buffer, "\n" );
	}

	/**
	 * Read the single byte at `$pos` — from the open handle, else the path; '' when
	 * unreadable. Moving the open handle's position is safe only because
	 * `get_file_batch()` seeks before every block read.
	 */
	private function read_byte_at( int $pos ): string {
		if ( null === $this->follow_handle ) {
			// 'end' asks before the handle opens; the path answers.
			$path = $this->source_file;
			if ( '' === $path || ! \is_file( $path ) ) {
				return '';
			}
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
			$handle = @\fopen( $path, 'rb' );
			if ( false === $handle ) {
				return '';
			}
			\fseek( $handle, $pos );
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fread
			$byte = \fread( $handle, 1 );
			\fclose( $handle );
			return \is_string( $byte ) ? $byte : '';
		}
		\fseek( $this->follow_handle, $pos );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fread
		$byte = \fread( $this->follow_handle, 1 );
		return \is_string( $byte ) ? $byte : '';
	}

	/**
	 * Offset the lag read may trust: a queued seek counts only while it still
	 * describes the file that is there — same generation, not past its end.
	 *
	 * A candidate is not yet validated; `validate_resume_offset()` runs at the
	 * first poll and cannot run here, with no follow handle open. Honouring a
	 * stale one lets a client echo a pre-rotation position and have the new
	 * generation declared caught up, so SSE_Out closes on the first tick and
	 * never delivers it. Falling back to the raw cursor reads as behind, which
	 * keeps the stream open long enough to validate and rewind. An unnamed
	 * generation is one of those stale cases — the poll will read the file
	 * whole — so only a candidate naming THIS one may be trusted.
	 */
	private function lag_cursor_offset(): int {
		$candidate = $this->file_seek_candidate;
		if ( null === $candidate ) {
			return $this->cursor_offset;
		}
		$stat = $this->path_stat();
		if ( null === $candidate['inode'] || null === $stat || $candidate['inode'] !== $stat['ino'] ) {
			return $this->cursor_offset;
		}
		return $candidate['offset'] > $stat['size']
			? $this->cursor_offset
			: $candidate['offset'];
	}

	/** Current byte size of the followed path, or 0 when it is absent. */
	private function file_current_size(): int {
		return $this->path_stat()['size'] ?? 0;
	}

	/** Inode of the followed path right now, or 0 when it is absent. */
	private function file_current_inode(): int {
		return $this->path_stat()['ino'] ?? 0;
	}

	/**
	 * The ONE stat of the followed path: size, inode and mtime out of a single
	 * clearstatcache+stat pair, so a caller needing two of them pays one syscall
	 * and reads a consistent triple instead of three separately-timed ones.
	 *
	 * @return array{size:int,ino:int,mtime:int}|null Null when the path is absent.
	 */
	private function path_stat(): ?array {
		$path = $this->source_file;
		if ( '' === $path ) {
			return null;
		}
		\clearstatcache( true, $path );
		// One targeted stat; false doubles as the existence check.
		$stat = @\stat( $path );
		if ( false === $stat ) {
			return null;
		}
		return [
			'size'  => $stat['size'],
			'ino'   => $stat['ino'],
			'mtime' => $stat['mtime'],
		];
	}

	/**
	 * Probe snapshot: the parent's record, relabelled. Every position and
	 * counter comes from the inherited path — `compute_lag()` above is the only
	 * substitution — so the dashboard and the GET_LAG reply cannot drift.
	 *
	 * @return array<int,int|string>
	 */
	public function probe_stats(): array {
		$record                         = parent::probe_stats();
		$record[ Probe_Record::SOURCE ] = '' !== $this->source_file ? \basename( $this->source_file ) : '';
		return $record;
	}

	/**
	 * Frame extras. There is no source_dir, so the inherited source_log would be
	 * blank — label the frame by the followed filename instead. The inode is NOT
	 * added: it already rides the frame's `segment` container slot.
	 *
	 * @return array<array-key,mixed>
	 */
	protected function checkpoint_frame_extra(): array {
		$extra                = parent::checkpoint_frame_extra();
		$extra['source_log']  = '' !== $this->source_file ? \basename( $this->source_file ) : '';
		return $extra;
	}

	/**
	 * A single inode is not a segment list, so this reader owns no source
	 * Partition. Refusing by NAME is the point: the parent's bare
	 * "not initialized" would send a reader hunting for a missed arguments()
	 * call instead of the method that does not apply here.
	 *
	 * @throws \RuntimeException Always; there is no Partition to return.
	 */
	protected function source(): Partition_Node {
		throw new \RuntimeException(
			'File_Tail follows one inode and has no source Partition; use compute_lag() or the followed path'
		);
	}

	/**
	 * Palette entry: Tail's, carrying the file-mode description. Arguments, verbs
	 * and category are inherited verbatim.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'description' => 'Follows a single filename with tail -F logrotate semantics (inode + byte offset); emits each line as raw TM_BYTESTREAM bytes to its sink.',
		] );
	}
}
