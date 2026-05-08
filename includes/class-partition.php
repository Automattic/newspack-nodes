<?php
/**
 * Partition: file-segmented append-only log.
 *
 * Lift-adapt from class-firehose.php. Adaptations:
 *  - No scandir in constructor (lazy first-use init)
 *  - $base_dir injected (no Config dependency)
 *  - Auto-locked allow_large_writes (Task 6)
 *
 * Storage primitive AND Node (Node integration in Task 6).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Partition extends Node {
	public const DEFAULT_SEGMENT_SIZE = 67108864;
	public const DEFAULT_NUM_SEGMENTS = 4;
	public const DEFAULT_MAX_LIFESPAN = 86400;
	public const MAX_LINE_SIZE        = 4096;
	public const MAX_LARGE_LINE_SIZE  = 10485760;
	public const MAX_READ_SIZE        = 10485760; // 10MB cap on read_at + scan_index per-file size.
	public const SEGMENT_CACHE_TTL    = 0.25;
	public const SEGMENT_PATTERN      = '/^(\d+)\.log$/';

	/** Inter-process rotation lock TTL: anything older counts as stale. */
	public const ROTATE_LOCK_TTL_SECONDS = 5;

	/** Max in-loop fwrite attempts before giving up on a partial write. */
	public const MAX_PARTIAL_WRITE_ATTEMPTS = 5;

	/** Minimum interval between drift-detection rescans inside do_write(). */
	public const DRIFT_RESCAN_INTERVAL_SECONDS = 1.0;

	protected string $base_dir;
	protected int $partition;
	protected int $segment_size;
	protected int $num_segments;
	protected int $max_lifespan;

	protected string $partition_dir;

	protected ?int $current_segment_id = null;
	protected int $current_size = 0;
	protected ?string $current_log_path = null;
	protected ?string $current_idx_path = null;

	/** @var resource|null */
	protected $fh = null;
	protected int $fh_segment_id = -1;
	/** @var resource|null */
	protected $idx_fh = null;

	protected ?array $segments_cache = null;
	protected float $segments_cache_time = 0.0;

	protected bool $allow_large_writes = false;
	protected ?Lock $write_lock = null;

	/** Last drift-rescan timestamp; throttles do_write rescans to once per second. */
	protected float $last_segment_check = 0.0;

	/** @var callable|null fn(string $line, array $position, ?array &$data) => string|null */
	protected $index_callback = null;

	public function __construct(
		string $base_dir,
		int $partition,
		int $segment_size = self::DEFAULT_SEGMENT_SIZE,
		int $num_segments = self::DEFAULT_NUM_SEGMENTS,
		int $max_lifespan = self::DEFAULT_MAX_LIFESPAN
	) {
		$this->base_dir      = \rtrim( $base_dir, '/' );
		$this->partition     = $partition;
		$this->segment_size  = \max( 1, $segment_size );
		$this->num_segments  = \max( 2, $num_segments );
		$this->max_lifespan  = \max( 0, $max_lifespan );
		$this->partition_dir = "{$this->base_dir}/p{$partition}";
	}

	public function partition_dir(): string {
		return $this->partition_dir;
	}

	public function get_segment_path( int $segment_id ): string {
		if ( $segment_id < 0 ) {
			throw new \InvalidArgumentException( 'Segment ID must be non-negative' );
		}
		return "{$this->partition_dir}/{$segment_id}.log";
	}

	/**
	 * Node entry point: dispatch by message type.
	 *
	 * - TM_BYTESTREAM: append VALUE to current segment; ack via answer() if TM_PERSIST.
	 * - TM_REQUEST: parse "GET <seg> <offset> <length>"; respond with bytes via sink.
	 *
	 * @param array $message Reference; not mutated.
	 */
	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];

		if ( $type & Message::TM_BYTESTREAM ) {
			$ok = $this->write( $message[ Message::VALUE ] );
			if ( $type & Message::TM_PERSIST ) {
				if ( $ok ) {
					$this->answer( $message );
				} else {
					// Write dropped (oversize) or fwrite failed — release the producer's
					// max_unanswered slot via cancel, NOT answer. Otherwise data loss is silent.
					$this->cancel( $message );
				}
			}
			return;
		}

		if ( $type & Message::TM_REQUEST ) {
			$req = $message[ Message::VALUE ];
			if ( \preg_match( '/^GET (\d+) (\d+) (\d+)$/', $req, $m ) ) {
				$bytes                      = $this->read_at( (int) $m[1], (int) $m[2], (int) $m[3] );
				$resp                       = Message::new_message();
				$resp[ Message::TYPE ]      = Message::TM_RESPONSE;
				$resp[ Message::TIMESTAMP ] = Core::$right_now;
				$resp[ Message::FROM ]      = $this->name;
				$resp[ Message::TO ]        = $message[ Message::FROM ];
				$resp[ Message::ID ]        = $message[ Message::ID ];
				$resp[ Message::VALUE ]     = $bytes;
				$this->sink?->fill( $resp );
			}
			return;
		}
	}

	public function __destruct() {
		$this->close_handle();
	}

	/**
	 * Close file handles + release write lock before normal Node teardown.
	 * Without this, files only close at GC/__destruct, leaving a window where
	 * a stale handle can race against rotate-via-mkdir-lock.
	 */
	public function remove_node(): void {
		$this->close_handle();
		if ( $this->write_lock !== null ) {
			$this->write_lock->release();
			$this->write_lock = null;
		}
		parent::remove_node();
	}

	protected function close_handle(): void {
		if ( \is_resource( $this->fh ) ) {
			@\fclose( $this->fh );
			$this->fh = null;
			$this->fh_segment_id = -1;
		}
		if ( \is_resource( $this->idx_fh ) ) {
			@\fclose( $this->idx_fh );
			$this->idx_fh = null;
		}
	}

	public static function hash_to_partition( string $key, int $num_partitions ): int {
		[ $stripped ] = \explode( '?', $key, 2 );
		return ( \crc32( $stripped ) & 0x7FFFFFFF ) % $num_partitions;
	}

	/**
	 * Initialize current segment state from existing segments on disk.
	 * Does NOT create files — segment files materialize on first write via fopen('a').
	 */
	protected function init_current_segment(): void {
		$this->close_handle();
		$segments = $this->get_segments( true );
		if ( empty( $segments ) ) {
			$this->current_segment_id = 0;
			$this->current_size       = 0;
			$this->current_log_path   = "{$this->partition_dir}/0.log";
			$this->current_idx_path   = "{$this->partition_dir}/0.idx";
			return;
		}
		$newest                   = \end( $segments );
		$this->current_segment_id = $newest['id'];
		$this->current_size       = $newest['size'];
		$this->current_log_path   = "{$this->partition_dir}/{$this->current_segment_id}.log";
		$this->current_idx_path   = "{$this->partition_dir}/{$this->current_segment_id}.idx";
	}

	/**
	 * List segments on disk sorted by id, cached for SEGMENT_CACHE_TTL.
	 *
	 * @param bool $force_refresh Skip the cache and rescan.
	 * @return array<int,array{id:int,size:int}>
	 */
	public function get_segments( bool $force_refresh = false ): array {
		$now = \microtime( true );
		if ( ! $force_refresh && null !== $this->segments_cache && ( $now - $this->segments_cache_time ) < self::SEGMENT_CACHE_TTL ) {
			return $this->segments_cache;
		}
		$segments = [];
		if ( ! \is_dir( $this->partition_dir ) ) {
			$this->segments_cache      = [];
			$this->segments_cache_time = $now;
			return [];
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_scandir
		$files = @\scandir( $this->partition_dir );
		if ( ! $files ) {
			$this->segments_cache      = [];
			$this->segments_cache_time = $now;
			return [];
		}
		foreach ( $files as $f ) {
			if ( \preg_match( self::SEGMENT_PATTERN, $f, $m ) ) {
				$segments[] = [ 'id' => (int) $m[1], 'size' => @\filesize( "{$this->partition_dir}/{$f}" ) ?: 0 ];
			}
		}
		\usort( $segments, fn ( $a, $b ) => $a['id'] <=> $b['id'] );
		$this->segments_cache      = $segments;
		$this->segments_cache_time = $now;
		return $segments;
	}

	/**
	 * Lift the line-size limit to 10MB and serialize writes via Lock.
	 *
	 * @return self
	 */
	public function allow_large_writes(): self {
		$this->allow_large_writes = true;
		$this->write_lock         = new Lock( "{$this->partition_dir}/write.lock.d", 60 );
		return $this;
	}

	/**
	 * Enable companion index files via a custom formatter callback.
	 *
	 * Replaces the default binary `pack('NN', ...)` format with caller-supplied
	 * JSONL (or any other shape returned by the formatter). Used by
	 * RequestBuilder::format_index_entry and FlameBuilder::format_index_entry.
	 *
	 * @param callable $callback fn(string $line, array $position, ?array &$data) => string|null
	 *                           Return null to skip the entry; '' is treated as overflow-skip.
	 * @return self
	 */
	public function with_index( callable $callback ): self {
		$this->index_callback = $callback;
		return $this;
	}

	/**
	 * Get the current write position (segment_id + tail offset of the active segment).
	 *
	 * @return array{segment_id:int, offset:int}
	 */
	public function get_current_position(): array {
		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}
		return [
			'segment_id' => (int) $this->current_segment_id,
			'offset'     => $this->current_size,
		];
	}

	/**
	 * Write a line to the current segment + companion .idx entry.
	 *
	 * @param string $line Line to append (caller includes trailing newline).
	 * @param array|null $data Optional pre-decoded data passed through to the
	 *                         index callback (so callers can avoid a redundant decode).
	 * @return bool True on success, false if dropped (size limit) or write failed.
	 */
	public function write( string $line, ?array &$data = null ): bool {
		$max = $this->allow_large_writes ? self::MAX_LARGE_LINE_SIZE : self::MAX_LINE_SIZE;
		if ( \strlen( $line ) > $max ) {
			return false;
		}

		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}

		if ( $this->allow_large_writes ) {
			return (bool) $this->write_lock->with_lock( fn () => $this->do_write( $line, $data ) );
		}
		return $this->do_write( $line, $data );
	}

	/**
	 * Write pre-formatted bytes WITHOUT appending a newline, WITHOUT the line-size check,
	 * and WITHOUT invoking the index callback. Used by callers who batched multiple
	 * formatted lines into a single buffer (LogManager flush).
	 *
	 * Caller is responsible for keeping each constituent line ≤PIPE_BUF.
	 *
	 * @param string $bytes Pre-formatted bytes (caller-supplied newlines).
	 * @return bool True on success.
	 */
	public function write_raw( string $bytes ): bool {
		if ( '' === $bytes ) {
			return true;
		}
		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}
		if ( $this->allow_large_writes ) {
			return (bool) $this->write_lock->with_lock( fn () => $this->do_raw_write( $bytes ) );
		}
		return $this->do_raw_write( $bytes );
	}

	/**
	 * Append pre-formatted bytes to the current segment with rotation + drift handling.
	 * Skips the index callback (write_raw is for batched line buffers).
	 *
	 * @param string $bytes Bytes to append.
	 * @return bool True on success.
	 */
	protected function do_raw_write( string $bytes ): bool {
		$len = \strlen( $bytes );
		$this->maybe_rescan_segments();

		if ( $this->current_size + $len > $this->segment_size ) {
			$this->rotate_segment();
		}

		$fh = $this->get_handle();
		if ( null === $fh ) {
			return false;
		}

		if ( ! $this->loop_fwrite( $fh, $bytes ) ) {
			return false;
		}

		$this->touch_segments_cache();
		return true;
	}

	/**
	 * Append to the current segment + write companion index entry.
	 * Caller must have set $this->current_* state.
	 *
	 * @param string     $line Bytes to append.
	 * @param array|null $data Pre-decoded data passed to index callback.
	 * @return bool True on success.
	 */
	protected function do_write( string $line, ?array &$data = null ): bool {
		$len = \strlen( $line );
		$this->maybe_rescan_segments();

		if ( $this->current_size + $len > $this->segment_size ) {
			$this->rotate_segment();
		}

		$fh = $this->get_handle();
		if ( null === $fh ) {
			return false;
		}
		$offset = $this->current_size;
		if ( ! $this->loop_fwrite( $fh, $line ) ) {
			return false;
		}

		// Companion index: caller-supplied formatter wins; default is binary pack.
		if ( null !== $this->index_callback ) {
			$position = [
				'segment_id' => $this->current_segment_id,
				'offset'     => $offset,
				'length'     => $len,
			];
			try {
				$entry = ( $this->index_callback )( $line, $position, $data );
				if ( null !== $entry && '' !== $entry && \is_resource( $this->idx_fh ) ) {
					// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
					@\fwrite( $this->idx_fh, $entry . "\n" );
				}
			} catch ( \Throwable $e ) {
				Core::print_less_often( 'Partition: index callback threw: ' . $e->getMessage() );
			}
		} elseif ( \is_resource( $this->idx_fh ) ) {
			// Default binary 8-byte format: <segment_id, offset> as two big-endian uint32s.
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
			@\fwrite( $this->idx_fh, \pack( 'NN', $this->current_segment_id, $offset ) );
		}

		$this->touch_segments_cache();
		return true;
	}

	/**
	 * Drift / TOCTOU recovery: every DRIFT_RESCAN_INTERVAL_SECONDS, rescan the
	 * segment list and follow the newest if another writer rotated underneath us.
	 *
	 * Without this, a long-lived single-process writer can wedge on a stale segment_id
	 * after a peer (or test) rotated the directory.
	 */
	protected function maybe_rescan_segments(): void {
		$now = \microtime( true );
		if ( $now - $this->last_segment_check < self::DRIFT_RESCAN_INTERVAL_SECONDS ) {
			return;
		}
		$this->last_segment_check = $now;
		$segments                 = $this->get_segments( true );
		if ( empty( $segments ) ) {
			return;
		}
		$newest = \end( $segments );
		if ( $newest['id'] !== $this->current_segment_id ) {
			$this->close_handle();
			$this->current_segment_id = $newest['id'];
			$this->current_size       = $newest['size'];
			$this->current_log_path   = "{$this->partition_dir}/{$this->current_segment_id}.log";
			$this->current_idx_path   = "{$this->partition_dir}/{$this->current_segment_id}.idx";
		}
	}

	/**
	 * Loop fwrite up to MAX_PARTIAL_WRITE_ATTEMPTS to handle short writes.
	 * Updates $this->current_size as bytes go out.
	 *
	 * @param resource $fh    Open file handle (append mode).
	 * @param string   $bytes Bytes to write.
	 * @return bool True if all bytes were written.
	 */
	protected function loop_fwrite( $fh, string $bytes ): bool {
		$remaining = $bytes;
		$attempts  = 0;
		while ( '' !== $remaining ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
			$written = @\fwrite( $fh, $remaining );
			if ( false === $written || 0 === $written ) {
				++$attempts;
				if ( $attempts >= self::MAX_PARTIAL_WRITE_ATTEMPTS ) {
					Core::print_less_often( 'Partition: fwrite stalled (' . $attempts . " attempts) for {$this->current_log_path}" );
					return false;
				}
				continue;
			}
			$this->current_size += $written;
			$remaining           = \substr( $remaining, $written );
		}
		return true;
	}

	/**
	 * Mirror current_size back into the segments_cache so a stale cache hit
	 * doesn't lie about the active segment. Adds the segment if it's new.
	 */
	protected function touch_segments_cache(): void {
		if ( null === $this->segments_cache ) {
			return;
		}
		$found = false;
		foreach ( $this->segments_cache as $i => $s ) {
			if ( $s['id'] === $this->current_segment_id ) {
				$this->segments_cache[ $i ]['size'] = $this->current_size;
				$found                              = true;
				break;
			}
		}
		if ( ! $found ) {
			$this->segments_cache[] = [ 'id' => $this->current_segment_id, 'size' => $this->current_size ];
		}
	}

	/**
	 * Rotate to a new segment. Multi-writer-safe: acquires an mkdir lock at
	 * `{base}/locks/{topic}.p{N}.rotate.lock.d` so concurrent writers can't both
	 * create segment N+1. Stale locks (mtime older than ROTATE_LOCK_TTL_SECONDS)
	 * are forced.
	 *
	 * Single-writer mode (allow_large_writes()) skips the lock since the per-write
	 * Lock already serializes access.
	 */
	protected function rotate_segment(): void {
		$this->close_handle();

		// Single-writer / large-writes mode already serializes; skip the rotation lock.
		if ( $this->allow_large_writes ) {
			$this->do_rotate();
			return;
		}

		$log_name  = \basename( $this->base_dir );
		$log_base  = \dirname( $this->base_dir );
		$locks_dir = "{$log_base}/locks";
		$lock_dir  = "{$locks_dir}/{$log_name}.p{$this->partition}.rotate.lock.d";

		if ( ! \is_dir( $locks_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $locks_dir, 0755, true );
		}

		// Atomic acquire via mkdir.
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
		if ( ! @\mkdir( $lock_dir, 0755 ) ) {
			\clearstatcache( true, $lock_dir );
			$mtime = @\filemtime( $lock_dir );
			if ( false === $mtime ) {
				// Disappeared mid-check; back off and re-init from disk.
				\usleep( 50000 );
				$this->init_current_segment();
				return;
			}
			$age = \time() - $mtime;
			if ( $age < self::ROTATE_LOCK_TTL_SECONDS ) {
				// Another process is rotating; wait briefly and re-init from disk.
				\usleep( 50000 );
				$this->init_current_segment();
				return;
			}
			// Stale lock: force-clear and retry. If retry still fails, give up gracefully.
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir
			@\rmdir( $lock_dir );
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			if ( ! @\mkdir( $lock_dir, 0755 ) ) {
				$this->init_current_segment();
				return;
			}
		}

		try {
			$this->do_rotate();
		} finally {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir
			@\rmdir( $lock_dir );
		}
	}

	/**
	 * Perform the actual rotation. Called either with the rotation lock held
	 * (multi-writer) or without it (single-writer / allow_large_writes).
	 *
	 * Also detects "another writer already advanced": if the newest segment on
	 * disk still has room, just adopt it instead of bumping the id.
	 */
	protected function do_rotate(): void {
		// Force-refresh the segments list — the cache may pre-date a peer's rotation.
		$segments = $this->get_segments( true );

		if ( ! empty( $segments ) ) {
			$newest = \end( $segments );
			if ( $newest['size'] < $this->segment_size ) {
				// A peer already rotated and the new segment still has room. Adopt it.
				$this->current_segment_id = $newest['id'];
				$this->current_size       = $newest['size'];
				$this->current_log_path   = "{$this->partition_dir}/{$this->current_segment_id}.log";
				$this->current_idx_path   = "{$this->partition_dir}/{$this->current_segment_id}.idx";
				$this->segments_cache     = null;
				return;
			}
		}

		$next_id = empty( $segments ) ? 0 : ( \end( $segments )['id'] + 1 );

		$this->current_segment_id = $next_id;
		$this->current_size       = 0;
		$this->current_log_path   = "{$this->partition_dir}/{$next_id}.log";
		$this->current_idx_path   = "{$this->partition_dir}/{$next_id}.idx";
		$this->segments_cache     = null;

		// Defeat get_handle()'s file-missing TOCTOU guard: materialize the empty file
		// now so a concurrent reader/writer doesn't trip the "missing? must be a wipe"
		// path and re-init back to segment 0.
		if ( ! \is_dir( $this->partition_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $this->partition_dir, 0755, true );
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_touch, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_touch
		if ( ! @\touch( $this->current_log_path ) ) {
			Core::print_less_often( "Partition: touch() failed for {$this->current_log_path}" );
		}

		// Run retention right after rotating so we don't accumulate forever — matches
		// upstream Firehose::do_rotate().
		$this->cleanup_segments();
	}

	/**
	 * AND-gated retention: delete oldest segments when BOTH
	 * count > num_segments AND (now - mtime) >= max_lifespan.
	 */
	public function cleanup_segments(): void {
		$segments = $this->get_segments( true );
		$count    = \count( $segments );
		$now      = \time();

		while ( $count > $this->num_segments ) {
			$oldest = $segments[0];
			$path   = "{$this->partition_dir}/{$oldest['id']}.log";
			$mtime  = @\filemtime( $path );
			if ( false === $mtime || ( $now - $mtime ) < $this->max_lifespan ) {
				break;
			}
			@\unlink( $path );
			@\unlink( "{$this->partition_dir}/{$oldest['id']}.idx" );
			\array_shift( $segments );
			--$count;
		}
		$this->segments_cache = null;
	}

	/**
	 * Read bytes from a segment at a given offset.
	 *
	 * Bounds-checked: rejects negative IDs/offsets/lengths and lengths over
	 * MAX_READ_SIZE to prevent memory exhaustion from malicious or buggy callers.
	 *
	 * @param int $segment_id Segment to read from.
	 * @param int $offset     Byte offset within segment.
	 * @param int $length     Number of bytes to read.
	 * @return string Bytes read; empty string on bounds violation, missing file, or read failure.
	 */
	public function read_at( int $segment_id, int $offset, int $length ): string {
		if ( $segment_id < 0 || $offset < 0 || $length < 0 || $length > self::MAX_READ_SIZE ) {
			return '';
		}
		if ( 0 === $length ) {
			return '';  // fread() throws on $length === 0 in PHP 8.1+; short-circuit.
		}
		$path = $this->get_segment_path( $segment_id );
		if ( ! \file_exists( $path ) ) {
			return '';
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
		$fh = @\fopen( $path, 'r' );
		if ( false === $fh ) {
			return '';
		}
		@\fseek( $fh, $offset );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fread
		$bytes = @\fread( $fh, $length );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose
		@\fclose( $fh );
		return false !== $bytes ? $bytes : '';
	}

	/**
	 * Walk every .idx entry across all segments and invoke the callback per entry.
	 *
	 * Behavior depends on whether with_index() configured a custom formatter:
	 *   - Default (no custom formatter): each entry is 8 bytes packed as two
	 *     big-endian uint32s; callback signature is fn(int $segment_id, int $offset).
	 *   - Custom formatter (JSONL): each line in the .idx file is delivered as
	 *     a string; callback signature is fn(string $line, int $segment_id).
	 *
	 * Returns false from the callback to terminate the scan early.
	 *
	 * @param callable $cb           Per-entry callback.
	 * @param bool     $newest_first Iterate newest segment first (and entries within
	 *                               newest-first too) when true. Default oldest-first.
	 */
	public function scan_index( callable $cb, bool $newest_first = false ): void {
		$segments = $this->get_segments();
		if ( $newest_first ) {
			$segments = \array_reverse( $segments );
		}

		foreach ( $segments as $s ) {
			$idx_path = "{$this->partition_dir}/{$s['id']}.idx";
			if ( ! \file_exists( $idx_path ) ) {
				continue;
			}

			// Cap the per-file read at MAX_READ_SIZE so a runaway .idx file
			// can't OOM the worker on scan.
			$idx_size = @\filesize( $idx_path );
			if ( false === $idx_size || $idx_size > self::MAX_READ_SIZE ) {
				continue;
			}

			// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
			$idx = @\file_get_contents( $idx_path );
			if ( false === $idx ) {
				continue;
			}

			if ( null !== $this->index_callback ) {
				// Custom (JSONL) format.
				$lines = \explode( "\n", \rtrim( $idx, "\n" ) );
				if ( $newest_first ) {
					$lines = \array_reverse( $lines );
				}
				foreach ( $lines as $line ) {
					if ( '' === $line ) {
						continue;
					}
					$result = $cb( $line, $s['id'] );
					if ( false === $result ) {
						return;
					}
				}
				continue;
			}

			// Default binary 8-byte format.
			$len = \strlen( $idx );
			if ( $newest_first ) {
				for ( $i = $len - 8; $i >= 0; $i -= 8 ) {
					$entry = \substr( $idx, $i, 8 );
					if ( \strlen( $entry ) !== 8 ) {
						continue;
					}
					[ , $seg, $off ] = \unpack( 'N2', $entry );
					if ( false === $cb( $seg, $off ) ) {
						return;
					}
				}
			} else {
				for ( $i = 0; $i < $len; $i += 8 ) {
					$entry = \substr( $idx, $i, 8 );
					if ( \strlen( $entry ) !== 8 ) {
						break;
					}
					[ , $seg, $off ] = \unpack( 'N2', $entry );
					if ( false === $cb( $seg, $off ) ) {
						return;
					}
				}
			}
		}
	}

	/**
	 * Lazily open and cache the .log + .idx handles for the current segment.
	 *
	 * Re-init on partition_dir disappearance (recovery from rm -rf), and on missing
	 * current_log_path (defeats TOCTOU when a peer rotates between init and open).
	 *
	 * For single-writer scenarios (allow_large_writes), disable PHP's stream buffer
	 * so downstream readers see new entries immediately instead of waiting for the
	 * 8KB stdio buffer to fill.
	 *
	 * @return resource|null Log handle, or null on open failure.
	 */
	protected function get_handle() {
		if ( ! \is_dir( $this->partition_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $this->partition_dir, 0755, true );
			// Whole tree got wiped; reset state from disk (will land at segment 0).
			$this->init_current_segment();
		} elseif ( null !== $this->current_log_path && ! \file_exists( $this->current_log_path ) ) {
			// Active log file disappeared underneath us — re-init from on-disk state.
			$this->init_current_segment();
		}

		if ( null === $this->fh || $this->fh_segment_id !== $this->current_segment_id ) {
			$this->close_handle();
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
			$fh = @\fopen( $this->current_log_path, 'a' );
			if ( false === $fh ) {
				return null;
			}
			$this->fh            = $fh;
			$this->fh_segment_id = $this->current_segment_id;

			// Single-writer mode: disable PHP's 8KB stream buffer so SSE / Tail readers
			// see writes immediately (matches upstream Firehose).
			if ( $this->allow_large_writes ) {
				\stream_set_write_buffer( $this->fh, 0 );
			}

			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
			$idx_fh       = @\fopen( $this->current_idx_path, 'a' );
			$this->idx_fh = ( false === $idx_fh ) ? null : $idx_fh;
		}
		return $this->fh;
	}
}
