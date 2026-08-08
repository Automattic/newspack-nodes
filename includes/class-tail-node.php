<?php
/**
 * Tail: durable file follower with two source shapes.
 *
 * Segmented mode (the default) reads a Log's {file}.{seg} segments through the inherited
 * Consumer/Log/Partition read model — resume, snapshot co-commit, segment-roll and all.
 * File mode follows a SINGLE filename (e.g. wp-content/debug.log) with `tail -F` logrotate
 * semantics: within a run it holds the open handle, drains a rotated-away file to EOF before
 * reopening the path from 0, resets on in-place truncation, and tolerates a missing path. It
 * reuses the SAME cursor shape as the segmented shape — the inode simply occupies the container
 * slot where a segment id sits, so `<inode>:<offset>:<length>` rides the existing offsetlog
 * frame and DLQ machinery with no new field. A resume validates the persisted cursor against
 * the current file (inode match + size + a line-boundary newline check) and restarts from 0 on
 * any mismatch, at-least-once — never cross-generation hunting. Both shapes share the
 * Buffered_Pump line-assembly spine (partial-line buffering, per-line emit) and the durable
 * offsetlog cursor; only the byte-source differs. Mode is declared explicitly by the
 * `source_mode` argument (default 'segmented') and fails loud on anything else. Each mode
 * emits every complete line's raw bytes as a TM_BYTESTREAM via forward_line(). A fresh Tail
 * with no durable cursor defaults to END.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tail_Node extends Consumer_Node {

	/** Read a Log's {file}.{seg} segments through the Consumer segment model. */
	public const MODE_SEGMENTED = 'segmented';

	/** Follow a single filename with `tail -F` logrotate semantics (inode + byte offset). */
	public const MODE_FILE = 'file';

	/** Source log base path; segments are {source_file}.0, {source_file}.1, … */
	protected string $source_file = '';

	/** Which source shape this Tail follows; set from the schema arg, validated fail-loud. */
	protected string $source_mode = self::MODE_SEGMENTED;

	/**
	 * File mode: the open read handle for the currently-followed generation, or null when the
	 * path is absent. A rotated-away generation stays open here until drained to EOF.
	 *
	 * In file mode the inode of this generation lives in the inherited $cursor_segment — the
	 * SAME container slot the segmented shape uses for the segment id. That reuse is what makes
	 * `<inode>:<offset>:<length>` ride the existing machinery (offsetlog frame, DLQ ID) with no
	 * new field: slot one just means "which container" — a segment id for segments, an inode for
	 * a single file. 0 = no open container.
	 *
	 * @var resource|null
	 */
	protected $follow_handle = null;

	/**
	 * File mode: an explicit array-form next_offset() seek {inode, offset} made BEFORE the file
	 * opens (build time), awaiting validation on the first poll once the live inode is known. A
	 * runtime seek (handle already open) validates immediately and leaves this null. null = none.
	 * A null `inode` means the seek named no generation: apply it to the current one.
	 *
	 * @var array{inode:int|null,offset:int}|null
	 */
	private ?array $file_seek_candidate = null;

	/**
	 * Store the token array, validate the mode, then arm the reader. File mode skips the
	 * segmented source Partition entirely (its segment model can't identify a single inode)
	 * and arms the shared Buffered_Pump spine directly. The segmented branch delegates to
	 * parent::arguments(), which re-runs parse_schema_args() — idempotent, so that one double-parse
	 * is harmless; the file branch parses exactly once.
	 *
	 * @param list<string>|null $args
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		$this->assert_valid_source_mode();
		if ( self::MODE_FILE !== $this->source_mode ) {
			return parent::arguments( $args );
		}
		$this->offsetlog_dir = \rtrim( $this->offsetlog_dir, '/' );
		$this->ensure_offsetlog();
		$this->deadletter_dir = \rtrim( $this->deadletter_dir, '/' );
		$this->ensure_deadletter();
		// No I/O at construction; first poll opens + seats the cursor (ADR-5).
		$this->poll_cb = $this->poll_init( ... );
		$this->set_timer( self::POLL_INTERVAL_EOF_MS, true );
		$this->set_state( 'POLLING', 'ACTIVE' );
		return $args;
	}

	/**
	 * File mode has no segmented source to compute lag against, so answer the GET_LAG request
	 * from the live file size here; segmented mode defers to Consumer's handler. The reply
	 * envelope mirrors Consumer::handle_request (which is private, hence the small repeat).
	 *
	 * @param array<int, mixed> $message
	 */
	public function fill( array $message ): void {
		if ( self::MODE_FILE !== $this->source_mode ) {
			parent::fill( $message );
			return;
		}
		$type = Core::num_int( $message[ Message::TYPE ] );
		if ( ! ( $type & Message::TM_REQUEST ) ) {
			parent::fill( $message );
			return;
		}
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		$verb    = \strtoupper( \explode( ' ', \trim( Core::as_string( $message[ Message::VALUE ] ) ), 2 )[0] );
		$payload = 'GET_LAG' === $verb ? $this->file_lag() : [ 'error' => "unknown request verb: {$verb}" ];

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$reply[ Message::FROM ]  = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		$reply[ Message::TO ]    = $message[ Message::FROM ];
		$reply[ Message::ID ]    = $message[ Message::ID ];
		$reply[ Message::KEY ]   = $message[ Message::KEY ];
		$reply[ Message::VALUE ] = [ 'verb' => $verb, 'data' => $payload ];
		$this->sink->fill( $reply );
	}

	/** Refill seam: segmented reads a Partition segment; file mode reads the followed inode. */
	protected function get_batch(): void {
		if ( self::MODE_FILE !== $this->source_mode ) {
			parent::get_batch();
			return;
		}
		$this->get_file_batch();
	}

	/**
	 * Boot seam. File mode: open the current generation (its inode into $cursor_segment), then seat
	 * the byte cursor with Consumer's precedence — durable-resume-wins:
	 *   1. a durable offsetlog frame (its `segment` slot is the stored inode), validated;
	 *   2. else an explicit build-time next_offset() hint — an array {inode,offset} seek is
	 *      validated the SAME way, a magic 'start'/'end' seek already seated cursor_offset;
	 *   3. else default to END.
	 * A build-time hint must LOSE to a durable checkpoint, or every respawn re-reads the whole file.
	 */
	protected function init_position(): void {
		if ( self::MODE_FILE !== $this->source_mode ) {
			parent::init_position();
			return;
		}
		$this->open_follow_file();
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
		$this->cursor_offset = $this->file_current_size();
	}

	/**
	 * Reposition the read cursor. File mode has no segments: 'end' is the file size, 'start'/'recent'
	 * are 0, and an explicit array {segment: inode, offset} is a RESUME CANDIDATE validated through
	 * the same validate_resume_offset() path as a durable frame (inode mismatch / shrink / non-newline
	 * boundary → 0). A runtime seek (handle already open) validates now; a build-time one defers to the
	 * first poll. Segmented defers to Consumer.
	 *
	 * @param string|array<array-key, mixed> $position Magic value or explicit {segment,offset}.
	 */
	public function next_offset( $position ): void {
		if ( self::MODE_FILE !== $this->source_mode ) {
			parent::next_offset( $position );
			return;
		}
		$this->offset_set          = true;
		$this->buffer              = '';
		$this->at_eof              = false;
		$this->file_seek_candidate = null;
		if ( \is_array( $position ) ) {
			// Absent stays absent: coerced, a closed handle stores inode 0.
			$inode  = isset( $position['segment'] ) ? Core::num_int( $position['segment'] ) : null;
			$offset = \max( 0, Core::num_int( $position['offset'] ?? 0 ) );
			if ( null !== $this->follow_handle ) {
				$this->cursor_offset = $this->validate_resume_offset( $inode, $offset );
			} else {
				$this->file_seek_candidate = [ 'inode' => $inode, 'offset' => $offset ];
			}
			return;
		}
		$this->cursor_offset = 'end' === $position ? $this->file_current_size() : 0;
	}

	/**
	 * Probe snapshot. File mode reports lag as file-size − read-position (no segments); segmented
	 * defers to Consumer. Draining, like the parent: counters ride as the work done since the
	 * previous sweep. Topic_Probe already try/catches, but a clean record beats a skipped one.
	 *
	 * @return array<int,int|string>
	 */
	public function probe_stats(): array {
		if ( self::MODE_FILE !== $this->source_mode ) {
			return parent::probe_stats();
		}
		$size                                   = $this->file_current_size();
		$window                                 = $this->drain_probe_window();
		$record                                 = [];
		$record[ Probe_Record::SOURCE ]         = '' !== $this->source_file ? \basename( $this->source_file ) : '';
		$record[ Probe_Record::READER ]         = '' !== $this->offsetlog_dir ? \basename( $this->offsetlog_dir ) : '';
		$record[ Probe_Record::CURSOR_SEGMENT ] = $this->cursor_segment;
		$record[ Probe_Record::CURSOR_OFF ]     = $this->cursor_offset;
		$record[ Probe_Record::END_SEGMENT ]    = $this->cursor_segment;
		$record[ Probe_Record::END_SIZE ]       = $size;
		$record[ Probe_Record::DISTANCE ]       = \max( 0, $size - ( $this->cursor_offset + \strlen( $this->buffer ) ) );
		$record[ Probe_Record::MSGS_DELTA ]     = $window['msgs'];
		$record[ Probe_Record::END_BYTES ]      = $size;
		$record[ Probe_Record::CACHE_SIZE ]     = 0;
		$record[ Probe_Record::BYTES_READ_DELTA ] = $window['bytes'];
		$record[ Probe_Record::ELAPSED_MS ]     = $window['elapsed_ms'];
		return $record;
	}

	public function remove_node(): void {
		$this->close_follow_handle();
		parent::remove_node();
	}

	/**
	 * File-mode refill (one block per tick, yielding the event loop). First drains the currently
	 * open generation — reading appended bytes, resetting on an in-place truncation. Only once
	 * that handle is at EOF does it consult the PATH: a same-inode path means caught up, a missing
	 * path is a rotation gap (keep polling), and a different inode is a rotation — the drained old
	 * handle closes and the new generation opens at offset 0. Draining-before-switching is what
	 * guarantees a rotated file's tail-end emits before the new file's first line.
	 *
	 * Self-contained because Consumer's segment read model (get_segments / read_at over
	 * {file}.{seg}) cannot express single-inode identity, in-place truncation, or reopen-on-rotate.
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
				$this->cursor_offset = 0;
				$this->buffer        = '';
				$read_pos            = 0;
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
					return;
				}
			}
			// Open generation drained; fall through to the rotation check.
		}

		// One targeted stat; false === $stat doubles as the existence check.
		$path_stat  = @\stat( $path );
		$path_inode = false === $path_stat ? 0 : $path_stat['ino'];

		if ( null !== $this->follow_handle && 0 !== $path_inode && $path_inode === $this->cursor_segment ) {
			$this->at_eof = false === \strpos( $this->buffer, "\n" );
			return;
		}
		if ( 0 === $path_inode ) {
			// Path missing (rotation gap): keep polling, not an error.
			$this->at_eof = false === \strpos( $this->buffer, "\n" );
			return;
		}
		$this->open_new_generation( $path );
	}

	/** Open the followed path (if present); its inode goes into the container slot. Silent when absent (missing-file grace). */
	private function open_follow_file(): void {
		$this->close_follow_handle();
		$this->cursor_segment = 0;
		$path                 = $this->source_file;
		if ( '' === $path || ! \is_file( $path ) ) {
			return;
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
		$handle = @\fopen( $path, 'rb' );
		if ( false === $handle ) {
			return;
		}
		$this->follow_handle  = $handle;
		$stat                 = \fstat( $handle );
		$this->cursor_segment = false === $stat ? 0 : $stat['ino'];
	}

	/**
	 * Switch to a freshly-rotated generation: close the drained old handle, drop its residual
	 * partial (a dead file's incomplete last line, mirroring Tachikoma's note_fh line_buffer
	 * clear), open the new inode into the container slot and reset the byte cursor to 0.
	 */
	private function open_new_generation( string $path ): void {
		$this->close_follow_handle();
		$this->buffer = '';
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
		$handle = @\fopen( $path, 'rb' );
		if ( false === $handle ) {
			// Reappeared then vanished (race): treat as missing and poll again.
			$this->cursor_segment = 0;
			$this->at_eof         = true;
			return;
		}
		$this->follow_handle  = $handle;
		$stat                 = \fstat( $handle );
		$this->cursor_segment = false === $stat ? 0 : $stat['ino'];
		$this->cursor_offset  = 0;
		$this->at_eof         = false;
	}

	private function close_follow_handle(): void {
		if ( null !== $this->follow_handle ) {
			\fclose( $this->follow_handle );
			$this->follow_handle = null;
		}
	}

	/**
	 * Validate a persisted cursor against the CURRENT file and return the offset to resume at. The
	 * frame's container slot is the stored inode; a Tail checkpoints only at line boundaries, so a
	 * legitimate cursor always sits just past a newline. Three cheap checks — a different current
	 * inode, a shrunk file (size < cursor), or a byte-before-cursor that is not "\n" — each restart
	 * from 0 of the current file (no cross-generation hunting). Failure mode is at-least-once
	 * (duplicate lines), never lost lines. cursor == size (the file ends exactly on the last emitted
	 * newline) is valid and simply reads nothing until it grows.
	 */
	private function validate_resume_offset( ?int $stored_inode, int $cursor ): int {
		if ( $cursor <= 0 ) {
			return 0;
		}
		if ( 0 === $this->cursor_segment ) {
			return 0;
		}
		// A null inode means the current generation; size + boundary guard it.
		if ( null !== $stored_inode && $stored_inode !== $this->cursor_segment ) {
			return 0;
		}
		$size = $this->file_current_size();
		if ( $size < $cursor ) {
			return null === $stored_inode ? $size : 0;
		}
		if ( "\n" === $this->read_byte_at( $cursor - 1 ) ) {
			return $cursor;
		}
		// @longform A container-less resume is a LIVE TAIL saying "put me back
		// where I was". Its offset is the raw file size, which is not a line
		// boundary when the log was sampled mid-write — and answering 0 there
		// dumps the whole file to a viewer that asked to follow the end.
		// Falling forward to the current end loses at most a partial line; a
		// durable resume (named inode) keeps restarting from 0.
		return null === $stored_inode ? $size : 0;
	}

	/** Read the single byte at $pos from the open follow handle, or '' when it can't be read. */
	private function read_byte_at( int $pos ): string {
		if ( null === $this->follow_handle ) {
			return '';
		}
		\fseek( $this->follow_handle, $pos );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fread
		$byte = \fread( $this->follow_handle, 1 );
		return \is_string( $byte ) ? $byte : '';
	}

	/**
	 * File-mode override: one followed path, so its own mtime is the answer.
	 * Segmented mode keeps the parent's newest-segment walk.
	 *
	 * @return float|null Epoch seconds the followed file last grew.
	 */
	public function idle_since(): ?float {
		if ( self::MODE_FILE !== $this->source_mode ) {
			return parent::idle_since();
		}
		$path = $this->source_file;
		if ( ! $this->file_lag()['caught_up'] || '' === $path || ! \is_file( $path ) ) {
			return null;
		}
		\clearstatcache( true, $path );
		$mtime = @\filemtime( $path );
		return \is_int( $mtime ) ? (float) $mtime : null;
	}

	/** @return array{bytes_behind:int, segments_behind:int, caught_up:bool, end_segment:int, end_size:int, end_bytes:int} */
	private function file_lag(): array {
		$size         = $this->file_current_size();
		$bytes_behind = \max( 0, $size - $this->cursor_offset );
		return [
			'bytes_behind'    => $bytes_behind,
			'segments_behind' => 0,
			'caught_up'       => 0 === $bytes_behind,
			'end_segment'     => 0,
			'end_size'        => $size,
			'end_bytes'       => $size,
		];
	}

	/** Current byte size of the followed path, or 0 when it is absent. */
	private function file_current_size(): int {
		$path = $this->source_file;
		if ( '' === $path || ! \is_file( $path ) ) {
			return 0;
		}
		\clearstatcache( true, $path );
		$size = \filesize( $path );
		return false === $size ? 0 : $size;
	}

	/** Fail loud on an unknown mode token (errors-as-docs). */
	private function assert_valid_source_mode(): void {
		if ( self::MODE_SEGMENTED === $this->source_mode || self::MODE_FILE === $this->source_mode ) {
			return;
		}
		throw new \InvalidArgumentException( \esc_html(
			"Tail: unknown source_mode '{$this->source_mode}'. The 4th argument must be '"
			. self::MODE_SEGMENTED . "' (read a Log's {file}.{seg} segments) or '"
			. self::MODE_FILE . "' (follow a single filename with logrotate semantics); it defaults to '"
			. self::MODE_SEGMENTED . "' when omitted."
		) );
	}

	/**
	 * File-mode override: drop the container when the inode is not known yet.
	 *
	 * @longform The byte offset is seated eagerly by next_offset(), but the
	 * inode reaches cursor_segment only when the handle opens on the first
	 * poll — and a stream that closes idle before polling never gets there.
	 * Advertising `0:<offset>` resumes against inode 0, which never validates,
	 * so the reader restarts from the top of the file on every reconnect. An
	 * empty container means "this offset, in whatever generation is current",
	 * which is what next_offset() already does for a missing `segment` key.
	 *
	 * @return string `{inode}:{offset}`, or `:{offset}` while the inode is unknown.
	 */
	public function cursor_position(): string {
		if ( self::MODE_FILE !== $this->source_mode ) {
			return parent::cursor_position();
		}
		$inode  = $this->cursor_segment;
		$offset = $this->cursor_offset;
		// A pending seek IS the position; cursor_offset is 0 until the poll.
		if ( null !== $this->file_seek_candidate ) {
			$inode  = $this->file_seek_candidate['inode'] ?? 0;
			$offset = $this->file_seek_candidate['offset'];
		}
		return ( 0 === $inode ? '' : (string) $inode ) . ':' . $offset;
	}

	/** Seam: read a Log ({file}.{seg}), not a Partition ({dir}/{seg}.log). Segmented mode only. */
	protected function make_source(): Partition_Node {
		return new Log_Node();
	}

	/** Seam: Tail's segmented args are source_file + offsetlog_dir. */
	protected function resolve_args(): array {
		return [ $this->source_file, $this->offsetlog_dir ];
	}

	/** Seam: a fresh Tail with no durable cursor starts at END. */
	protected function default_offset(): ?string {
		return 'end';
	}

	/**
	 * Emit seam (overrides Consumer's Message-unpacking forward): emit one complete line's
	 * raw bytes — newline restored — as a TM_BYTESTREAM, FROM-stamped at this I/O boundary.
	 * The buffer/cursor scan that hands us each line stays in Buffered_Pump::drain_buffer(),
	 * so both source shapes reuse it (and both get line_mode for free). The ID carries this
	 * Tail's OWN position breadcrumb — `segment:offset:length` (the inode rides the segment
	 * slot in file mode) — which the browser seek tracker reads for its Replay→Live flip;
	 * the empty default silently disabled that flip for every Tail-fed stream.
	 *
	 * @param string $line       One complete line (without its trailing newline).
	 * @param int    $abs_offset The line's start offset within the current segment/generation.
	 */
	protected function forward_line( string $line, int $abs_offset ): void {
		$bytes = $line . "\n";
		$size  = \strlen( $bytes );
		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = Core::$now;
		$message[ Message::FROM ]      = '' !== $this->stamp_override ? $this->stamp_override : $this->name;
		$message[ Message::ID ]        = "{$this->cursor_segment}:{$abs_offset}:{$size}";
		$message[ Message::VALUE ]     = $bytes;
		parent::fill( $message );
	}

	/**
	 * Frame extras. File mode has no source_dir, so the inherited source_log would be blank —
	 * label the frame by the followed filename instead so dashboards aren't blank. The inode is
	 * NOT added here: it already rides the frame's `segment` container slot.
	 *
	 * @return array<array-key, mixed>
	 */
	protected function checkpoint_frame_extra(): array {
		$extra = parent::checkpoint_frame_extra();
		if ( self::MODE_FILE === $this->source_mode ) {
			$extra['source_log'] = '' !== $this->source_file ? \basename( $this->source_file ) : '';
		}
		return $extra;
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'description' => 'Tails a Log\'s {file}.{seg} segments, or follows a single filename with logrotate semantics; emits each line as raw TM_BYTESTREAM bytes to its sink.',
			// source_dir renamed source_file; adds the explicit mode arg.
			'arguments'   => [
				[ 'name' => 'source_file',    'type' => 'string', 'required' => true, 'description' => 'Segmented mode: base path of the Log to poll ({source_file}.0, .1, …). File mode: the single filename to follow (e.g. wp-content/debug.log). Each complete line is emitted.' ],
				[ 'name' => 'offsetlog_dir',  'type' => 'string', 'default' => '', 'description' => 'Directory for the durable read-cursor offsetlog (resume-after-restart); empty disables checkpointing.' ],
				[ 'name' => 'deadletter_dir', 'type' => 'string', 'default' => '', 'description' => 'Directory where poison/dead-letter records are quarantined; empty disables the dead-letter queue.' ],
				[ 'name' => 'source_mode',    'type' => 'string', 'default' => self::MODE_SEGMENTED, 'description' => 'Source shape: "segmented" (default) reads a Log\'s {file}.{seg} segments; "file" follows a single filename with tail -F logrotate semantics (inode + byte offset).' ],
			],
		] );
	}
}
