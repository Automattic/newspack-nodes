<?php
/**
 * Partition: file-segmented append-only log.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Partition_Node extends Timer_Node {
	use Schema_Reflection;
	use File_Writer;

	public const DEFAULT_SEGMENT_SIZE = 67108864;
	public const DEFAULT_NUM_SEGMENTS = 4;
	public const DEFAULT_MAX_LIFESPAN = 0;
	public const MAX_LINE_SIZE        = 4096;
	public const MAX_LARGE_LINE_SIZE  = 33554432;
	public const SEGMENT_CACHE_TTL    = 0.25;
	public const SEGMENT_PATTERN      = '/^(\d+)\.log$/';

	/** Inter-process rotation lock TTL: anything older counts as stale. */
	public const ROTATE_LOCK_TTL_SECONDS = 5;

	public const DRIFT_RESCAN_INTERVAL_SECONDS = 1.0;

	protected string $dir           = '';
	protected int $segment_size     = self::DEFAULT_SEGMENT_SIZE;
	protected int $num_segments     = self::DEFAULT_NUM_SEGMENTS;
	protected int $max_lifespan     = self::DEFAULT_MAX_LIFESPAN;

	/** Resolved segment directory ( = the rtrim'd $dir ); segments live at {partition_dir}/{seg}.log. */
	protected string $partition_dir = '';

	protected ?int $current_segment_id = null;
	protected int $current_size = 0;
	protected ?string $current_log_path = null;
	protected ?string $current_idx_path = null;

	/** @var resource|null */
	protected $fh = null;
	protected int $fh_segment_id = -1;
	/** @var resource|null */
	protected $idx_fh = null;

	/** @var array<int, array{id:int, size:int}>|null Cached on-disk segment list (id + byte size), sorted by id. */
	protected ?array $segments_cache = null;
	protected float $segments_cache_time = 0.0;

	protected bool $allow_large_writes = false;
	/** True when the large-write cap was lifted via void_warranty() (no lock) rather than allow_large_writes() (held lock) — drives which verb dump_config round-trips. */
	private bool $warranty_voided = false;
	/** Formatter name set via the `with_index` verb — the round-trippable form of the index callback (which itself can't be dumped). */
	protected ?string $index_formatter_name = null;
	protected ?Lock_Node $write_lock = null;
	protected ?Timer_Node $heartbeat_timer = null;
	protected int $lock_stale_timeout = 0;
	protected float $last_lock_heartbeat = 0.0;

	protected float $last_segment_check = 0.0;

	/** @var (callable(string, array<string, mixed>, mixed): (string|null))|null fn(string $line, array $position, ?array &$data) => string|null */
	protected $index_callback = null;

	/** @var string Packed messages awaiting one PIPE_BUF-atomic syswrite. */
	protected string $batch = '';

	/** @var list<array{record:string,size:int,data:mixed}> Flushed in lockstep with $batch. */
	protected array $batch_index_args = [];

	/**
	 * get_segments() directory-scan seam. Lazily-defaulted at the call site to a
	 * closure wrapping the real scandir; tests reassign this in-place (then reset
	 * to null in a finally) to count or stub the directory scan WITHOUT
	 * short-circuiting the rest of get_segments()'s pattern-match + filesize +
	 * sort path, so that production logic stays under real coverage.
	 *
	 * Signature: `function ( string $dir ): array|false`.
	 *
	 * @var (\Closure(string): (list<string>|false))|null
	 */
	public static ?\Closure $scandir = null;

	/** Tachikoma-parity: no-arg ctor. Wires the sibling :config interpreter; positional config arrives via arguments(). */
	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	/**
	 * Store the raw string, parse positional tokens via parse_schema_args(), then
	 * normalize the values. partition_dir is the resolved $dir; a bare make_node
	 * leaves it ''. Getter returns the raw string.
	 *
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		$this->segment_size  = \max( 1, $this->segment_size );
		$this->num_segments  = \max( 2, $this->num_segments );
		$this->max_lifespan  = \max( 0, $this->max_lifespan );
		$this->partition_dir = \rtrim( $this->dir, '/' );
		return $args;
	}

	/**
	 * Node entry point: pack the message and append to the current segment.
	 *
	 * @param array<int, mixed> $message Reference; not mutated.
	 */
	public function fill( array &$message ): void {
		++$this->counter;

		// No-event-loop heartbeat: heartbeat() returns false if ownership was stolen, so throw.
		if ( $this->allow_large_writes && null === $this->heartbeat_timer && null !== $this->write_lock ) {
			$now = \microtime( true );
			if ( $now - $this->last_lock_heartbeat >= $this->lock_stale_timeout / 3.0 ) {
				if ( ! $this->write_lock->heartbeat() ) {
					throw new \RuntimeException(
						\esc_html(
							"Partition: write lock at {$this->write_lock_path()} "
							. 'no longer owned (stolen via stale-takeover); cannot continue.'
						)
					);
				}
				$this->last_lock_heartbeat = $now;
			}
		}

		// Beat the worker heartbeat from inside a long in-process job (see pump()).
		Event_Framework::instance()->pump();

		// Size cap is on the final packed bytes (not VALUE alone) — that's what hits PIPE_BUF.
		$record = $this->serialize_record( $message );
		$max    = $this->allow_large_writes ? self::MAX_LARGE_LINE_SIZE : self::MAX_LINE_SIZE;
		$size   = \strlen( $record );
		if ( $size > $max ) {
			$this->set_state(
				'DROPPED',
				\implode( ' ', [ 'REASON', 'oversize', 'SIZE', $size, 'MAX', $max ] )
			);
			return;
		}

		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}

		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}

		$this->maybe_rescan_segments();

		$data = null;

		// Large messages bypass the batch; flush pending batch first to preserve ordering.
		if ( $size > self::MAX_LINE_SIZE ) {
			$this->flush();
			if ( $this->current_size + $size > $this->segment_size ) {
				$this->rotate_segment();
			}
			$fh = $this->get_handle();
			if ( null === $fh ) {
				return;
			}
			$offset              = $this->current_size;
			$wrote               = $this->write_all( $fh, $record, $this->current_log_path );
			$this->current_size += $wrote;
			if ( $wrote < $size ) {
				return;
			}
			if ( null !== $this->index_callback ) {
				$this->write_index_entry( $record, $offset, $size, $data );
			}
			$this->touch_segments_cache();
			return;
		}

		// Flush if this message would push the batch over PIPE_BUF — keeps syswrites atomic.
		if ( '' !== $this->batch && \strlen( $this->batch ) + $size > self::MAX_LINE_SIZE ) {
			$this->flush();
		}

		if ( $this->current_size + $size > $this->segment_size ) {
			$this->rotate_segment();
		}

		$this->batch              .= $record;
		$this->batch_index_args[]  = [
			'record' => $record,
			'size'   => $size,
			'data'   => $data,
		];

		// 0-delay one-shot flush at the end of this event-loop iteration.
		$this->set_timer( 0, true );
	}

	/** Timer fire: drain the batch at the end of the current event-loop iteration. */
	protected function fire(): void {
		$this->flush();
	}

	/**
	 * Seam (Log overrides): bytes written per fill()'d message. Partition = packed envelope + newline.
	 *
	 * @param array<int, mixed> $message
	 */
	protected function serialize_record( array $message ): string {
		return Message::packed( $message ) . "\n";
	}

	/**
	 * Drift / TOCTOU recovery: rescan and follow the newest segment if a peer rotated.
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
			$this->current_log_path   = $this->get_segment_path( $this->current_segment_id );
			$this->current_idx_path   = $this->get_index_path( $this->current_segment_id );
		}
	}

	public function partition_dir(): string {
		return $this->segment_dir();
	}

	public function __destruct() {
		// Flush residual batched messages so request-scope writes aren't GC'd unwritten.
		$this->flush();
		$this->close_handle();
	}

	/** Append $batch to the current segment, then write companion index entries with post-flush offsets. */
	public function flush(): void {
		if ( '' === $this->batch ) {
			return;
		}
		$batch_bytes = $this->batch;
		$batch_args  = $this->batch_index_args;
		// Reset up-front so an exception below doesn't cause a re-flush loop.
		$this->batch             = '';
		$this->batch_index_args  = [];

		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}

		$batch_len = \strlen( $batch_bytes );
		if ( $this->current_size + $batch_len > $this->segment_size ) {
			$this->rotate_segment();
		}

		$fh = $this->get_handle();
		if ( null === $fh ) {
			return;
		}
		$start_offset        = $this->current_size;
		$wrote               = $this->write_all( $fh, $batch_bytes, $this->current_log_path );
		$this->current_size += $wrote;
		if ( $wrote < $batch_len ) {
			return;
		}

		if ( null !== $this->index_callback ) {
			$offset = $start_offset;
			foreach ( $batch_args as $item ) {
				$this->write_index_entry( $item['record'], $offset, $item['size'], $item['data'] );
				$offset += $item['size'];
			}
		}

		$this->touch_segments_cache();
	}

	/**
	 * Rotate to a new segment, multi-writer-safe via an mkdir lock.
	 *
	 * Single-writer mode (allow_large_writes) skips the lock — the per-write Lock serializes.
	 */
	protected function rotate_segment(): void {
		$this->close_handle();

		if ( $this->allow_large_writes ) {
			$this->do_rotate();
			return;
		}

		$lock_dir = $this->rotate_lock_path();
		$dir      = $this->segment_dir();

		if ( ! \is_dir( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $dir, 0755, true );
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
			// Stale lock: force-clear and retry.
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
	 * Perform the actual rotation, with or without the rotation lock held.
	 *
	 * Detects "a peer already advanced": adopt the newest segment if it still has room.
	 */
	protected function do_rotate(): void {
		// Multi-writer partitions force-refresh to detect a peer that already
		// rotated the dir behind us; a warranty-voided (single-writer) log has no
		// peer, so a warm-cache read suffices — saving a scandir per ~30s checkpoint.
		$segments = $this->get_segments( ! $this->warranty_voided );

		if ( ! empty( $segments ) ) {
			$newest = \end( $segments );
			if ( $newest['size'] < $this->segment_size ) {
				$this->current_segment_id = $newest['id'];
				$this->current_size       = $newest['size'];
				$this->current_log_path   = $this->get_segment_path( $this->current_segment_id );
				$this->current_idx_path   = $this->get_index_path( $this->current_segment_id );
				// Cache already holds the truth (incl. the adopted newest); keep it warm.
				return;
			}
		}

		$next_id = empty( $segments ) ? 0 : ( \end( $segments )['id'] + 1 );

		$this->current_segment_id = $next_id;
		$this->current_size       = 0;
		$this->current_log_path   = $this->get_segment_path( $next_id );
		$this->current_idx_path   = $this->get_index_path( $next_id );

		// Materialize the empty file so get_handle()'s missing-file guard doesn't reset to segment 0.
		if ( ! \is_dir( $this->segment_dir() ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $this->segment_dir(), 0755, true );
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_touch, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_touch
		if ( ! @\touch( $this->current_log_path ) ) {
			$this->print_less_often( "WARNING: touch() failed for {$this->current_log_path}" );
		}

		// Maintain the cache: the post-create list is the line-351 scan plus the
		// empty segment we just created. cleanup_segments() then prunes it in place
		// without a second scan.
		$this->segments_cache[]    = [ 'id' => $next_id, 'size' => 0 ];
		$this->segments_cache_time = \microtime( true );

		$this->cleanup_segments();

		$this->set_state( 'SEGMENT', (string) $this->current_segment_id );
	}

	/**
	 * AND-gated retention: delete oldest segments only when count > num_segments
	 * AND (now - mtime) >= max_lifespan.
	 */
	public function cleanup_segments(): void {
		// Operate on the maintained cache when warm; standalone callers (cold cache) force-scan.
		$segments       = null === $this->segments_cache ? $this->get_segments( true ) : $this->segments_cache;
		$count          = \count( $segments );
		$initial_count  = $count;
		$now            = \time();

		while ( $count > $this->num_segments ) {
			$oldest = $segments[0];
			$path   = $this->get_segment_path( $oldest['id'] );
			$mtime  = @\filemtime( $path );
			if ( false === $mtime || ( $now - $mtime ) < $this->max_lifespan ) {
				break;
			}
			// Partition's segment directory is base_dir-relative — not WP-managed.
			// phpcs:disable WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
			@\unlink( $path );
			@\unlink( $this->get_index_path( $oldest['id'] ) );
			// phpcs:enable
			\array_shift( $segments );
			--$count;
		}
		// Keep the pruned list as the warm cache instead of discarding it.
		$this->segments_cache      = \array_values( $segments );
		$this->segments_cache_time = \microtime( true );

		$deleted = $initial_count - $count;
		if ( $deleted > 0 ) {
			$this->set_state( 'CLEANUP', \implode( ' ', [ 'DELETED', $deleted, 'ALIVE', $count ] ) );
		}
	}

	/**
	 * Truncate the log AFTER a segment: delete every segment with id > $segment_id,
	 * then reset the write state so the log resumes coherently FROM $segment_id —
	 * the next rotate lands at $segment_id + 1, monotonic, no gap, no survivor
	 * overwritten. No-op when $segment_id is the newest, past the newest, or absent.
	 *
	 * Backs the Consumer time-travel PLAY truncate-on-resume: after a rewind seek,
	 * PLAY drops the now-stale forward frames before re-arming so the re-written
	 * timeline stays monotonic. The OFFSETLOG only — never the source log.
	 *
	 * SINGLE-WRITER ONLY: safe solely on a private single-writer log (the consumer's
	 * offsetlog, lifted via void_warranty() — no lock). An allow_large_writes()-locked
	 * partition is a multi-writer-guarded SOURCE; truncating it races a peer append, so
	 * this throws (mirroring allow_large_writes()'s fail-loud contract) rather than
	 * corrupt the log. The lock — not the lifted cap — distinguishes the two.
	 *
	 * @api Consumed by Consumer_Node::play() (time-travel replay), not in-substrate.
	 * @throws \RuntimeException when the partition holds an exclusivity write_lock.
	 */
	public function truncate_after( int $segment_id ): void {
		if ( null !== $this->write_lock ) {
			throw new \RuntimeException(
				\esc_html(
					"Partition::truncate_after() refused at {$this->write_lock_path()}: this partition "
					. 'holds an exclusivity write_lock (allow_large_writes), so it is a multi-writer-guarded '
					. 'source — truncation is single-writer only (the consumer offsetlog).'
				)
			);
		}
		$segments = $this->get_segments( true );
		$sizes    = \array_column( $segments, 'size', 'id' );
		if ( ! isset( $sizes[ $segment_id ] ) ) {
			return; // Absent or past the newest — nothing to truncate.
		}

		$survivors = [];
		foreach ( $segments as $s ) {
			if ( $s['id'] <= $segment_id ) {
				$survivors[] = $s;
				continue;
			}
			// Partition's segment directory is base_dir-relative — not WP-managed.
			// phpcs:disable WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
			@\unlink( $this->get_segment_path( $s['id'] ) );
			@\unlink( $this->get_index_path( $s['id'] ) );
			// phpcs:enable
		}

		$this->close_handle();
		$this->current_segment_id = $segment_id;
		$this->current_size       = $sizes[ $segment_id ];
		$this->current_log_path   = $this->get_segment_path( $segment_id );
		$this->current_idx_path   = $this->get_index_path( $segment_id );

		// $survivors is built by appending in id order, so it is already a 0-indexed
		// list matching get_segments()'s shape — no array_values() re-key needed.
		$this->segments_cache      = $survivors;
		$this->segments_cache_time = \microtime( true );
	}

	/** Seam (Log overrides): mkdir-lock dir serializing multi-writer rotation. */
	protected function rotate_lock_path(): string {
		return "{$this->segment_dir()}/.rotate.lock.d";
	}

	/**
	 * Lazily open and cache the .log + .idx handles for the current segment.
	 *
	 * @return resource|null Log handle, or null on open failure.
	 */
	protected function get_handle() {
		if ( ! \is_dir( $this->segment_dir() ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $this->segment_dir(), 0755, true );
			// Whole tree got wiped; reset from disk (lands at segment 0).
			$this->init_current_segment();
		} elseif ( null === $this->current_log_path || ! \file_exists( $this->current_log_path ) ) {
			// No active segment yet, or the active log file disappeared underneath us — (re-)init from disk.
			$this->init_current_segment();
		}

		// init_current_segment() always sets these together; bail if somehow unset.
		$log_path   = $this->current_log_path;
		$idx_path   = $this->current_idx_path;
		$segment_id = $this->current_segment_id;
		if ( null === $log_path || null === $idx_path || null === $segment_id ) {
			return null;
		}

		if ( null === $this->fh || $this->fh_segment_id !== $segment_id ) {
			$this->close_handle();
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
			$fh = @\fopen( $log_path, 'a' );
			if ( false === $fh ) {
				return null;
			}
			$this->fh            = $fh;
			$this->fh_segment_id = $segment_id;

			// Single-writer mode: disable PHP's 8KB buffer so readers see writes immediately.
			if ( $this->allow_large_writes ) {
				\stream_set_write_buffer( $this->fh, 0 );
			}

			// Only open the .idx companion when a with_index() formatter is set —
			// default mode writes no index, so no empty .idx should materialize.
			if ( null !== $this->index_callback ) {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
				$idx_fh       = @\fopen( $idx_path, 'a' );
				$this->idx_fh = ( false === $idx_fh ) ? null : $idx_fh;
			}
		}
		return $this->fh;
	}

	/**
	 * Initialize current segment state from existing segments on disk.
	 *
	 * Does NOT create files — segment files materialize on first write via fopen('a').
	 */
	protected function init_current_segment(): void {
		$this->close_handle();
		$segments = $this->get_segments( true );
		if ( empty( $segments ) ) {
			$this->current_segment_id = 0;
			$this->current_size       = 0;
			$this->current_log_path   = $this->get_segment_path( 0 );
			$this->current_idx_path   = $this->get_index_path( 0 );
			return;
		}
		$newest                   = \end( $segments );
		$this->current_segment_id = $newest['id'];
		$this->current_size       = $newest['size'];
		$this->current_log_path   = $this->get_segment_path( $this->current_segment_id );
		$this->current_idx_path   = $this->get_index_path( $this->current_segment_id );
	}

	/**
	 * Write one companion-index entry for a serialized record at $offset. Caller guards on $index_callback.
	 *
	 * @param mixed $data Opaque per-message data passed through to the index callback.
	 */
	private function write_index_entry( string $record, int $offset, int $len, $data ): void {
		$callback = $this->index_callback;
		if ( null === $callback ) {
			return;
		}
		$position = [
			'segment_id' => $this->current_segment_id,
			'offset'     => $offset,
			'length'     => $len,
		];
		try {
			$entry = $callback( $record, $position, $data );
			if ( null !== $entry && '' !== $entry && \is_resource( $this->idx_fh ) ) {
				$this->write_all( $this->idx_fh, $entry . "\n", $this->current_idx_path );
			}
		} catch ( \Throwable $e ) {
			$this->print_less_often( 'WARNING: index callback threw: ' . $e->getMessage() );
		}
	}

	/**
	 * Mirror current_size into segments_cache so a stale hit doesn't misreport the active segment.
	 */
	protected function touch_segments_cache(): void {
		if ( null === $this->segments_cache || null === $this->current_segment_id ) {
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

	/** Close file handles + release write lock before normal Node teardown. */
	public function remove_node(): void {
		$this->close_handle();
		if ( null !== $this->write_lock ) {
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

	/**
	 * Lift the line-size limit to 10MB and acquire a Lock serializing cross-process writes.
	 *
	 * Requires name() and sink() to be set BEFORE this is called.
	 *
	 * @param int $max_wait_ms Lock acquisition timeout (ms).
	 * @throws \RuntimeException when the lock cannot be acquired.
	 * @return self
	 */
	public function allow_large_writes( int $max_wait_ms = 65000 ): self {
		$stale_timeout = 60;
		$lock          = new Lock_Node( $this->write_lock_path(), $stale_timeout );

		// Sibling: name (when the partition is named), keep the partition's own
		// specific sink, and patron-link so dump_metadata hides it from the canvas.
		if ( '' !== $this->name ) {
			$lock->name( "{$this->name}:lock" );
		}
		$lock->sink( $this->sink );
		$lock->patron( $this );

		// Drain active: arm the heartbeat Timer. Request-scope: drive heartbeat from fill().
		$ef_running = Event_Framework::instance()->is_running();

		if ( ! $lock->acquire( $max_wait_ms ) ) {
			throw new \RuntimeException(
				\esc_html(
					"Partition::allow_large_writes() failed to acquire write lock at "
					. "{$this->write_lock_path()} after {$max_wait_ms}ms — another live writer holds it. "
					. 'Two concurrent writers on the same Partition is unsupported.'
				)
			);
		}

		$this->allow_large_writes  = true;
		$this->write_lock          = $lock;
		$this->lock_stale_timeout  = $stale_timeout;
		$this->last_lock_heartbeat = \microtime( true );

		if ( $ef_running ) {
			// Heartbeat cadence = stale_timeout/3 ms; three ticks per stale window.
			$this->heartbeat_timer = new Timer_Node();
			$this->heartbeat_timer->name( "{$this->name}:heartbeat" );
			$this->heartbeat_timer->arguments( (string) \intdiv( $stale_timeout * 1000, 3 ) );
			$this->heartbeat_timer->sink( $this->write_lock );
			$this->heartbeat_timer->key( 'heartbeat' );
			$this->heartbeat_timer->patron( $this );
		}

		return $this;
	}

	/** Seam (Log overrides): per-writer exclusivity lock dir for allow_large_writes(). */
	protected function write_lock_path(): string {
		return "{$this->segment_dir()}/write.lock.d";
	}

	/**
	 * Read bytes from a segment at a given offset (bounds-checked).
	 *
	 * @param int $segment_id Segment to read from.
	 * @param int $offset     Byte offset within segment.
	 * @param int $length     Number of bytes to read.
	 * @return string Bytes read; empty string on bounds violation, missing file, or read failure.
	 */
	public function read_at( int $segment_id, int $offset, int $length ): string {
		if ( $segment_id < 0 || $offset < 0 || $length < 0 ) {
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
		if ( false !== $bytes ) {
			$this->bytes_read += \strlen( $bytes );
			return $bytes;
		}
		return '';
	}

	/** Seam (Log overrides): data-file path for a segment. Partition = {dir}/{seg}.log. */
	public function get_segment_path( int $segment_id ): string {
		if ( $segment_id < 0 ) {
			throw new \InvalidArgumentException( 'Segment ID must be non-negative' );
		}
		return "{$this->segment_dir()}/{$segment_id}.log";
	}

	/**
	 * Walk every JSONL .idx entry across all segments and invoke the callback per entry.
	 *
	 * Only meaningful when a with_index() formatter is installed — without it no
	 * .idx is written, so this early-returns. Callback signature: fn(string $line,
	 * int $segment_id). Return false from the callback to terminate the scan early.
	 *
	 * @api
	 * @param callable $cb           Per-entry callback.
	 * @param bool     $newest_first Iterate newest segment first when true.
	 */
	public function scan_index( callable $cb, bool $newest_first = false ): void {
		if ( null === $this->index_callback ) {
			return;
		}

		$segments = $this->get_segments();
		if ( $newest_first ) {
			$segments = \array_reverse( $segments );
		}

		foreach ( $segments as $s ) {
			$idx_path = $this->get_index_path( $s['id'] );
			if ( ! \file_exists( $idx_path ) ) {
				continue;
			}

			// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
			$idx = @\file_get_contents( $idx_path );
			if ( false === $idx ) {
				continue;
			}

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
		}
	}

	/**
	 * List segments on disk sorted by id, cached for SEGMENT_CACHE_TTL.
	 *
	 * A warranty-voided (single-writer) log skips the TTL: with no peer able to
	 * change the dir behind it, its cache never goes stale, so it serves warm.
	 *
	 * @param bool $force_refresh Skip the cache and rescan.
	 * @return array<int,array{id:int,size:int}>
	 */
	public function get_segments( bool $force_refresh = false ): array {
		$now = \microtime( true );
		$cache_fresh = $this->warranty_voided || ( $now - $this->segments_cache_time ) < self::SEGMENT_CACHE_TTL;
		if ( ! $force_refresh && null !== $this->segments_cache && $cache_fresh ) {
			return $this->segments_cache;
		}
		$segments = [];
		$dir      = $this->segment_dir();
		if ( ! \is_dir( $dir ) ) {
			$this->segments_cache      = [];
			$this->segments_cache_time = $now;
			return [];
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_scandir
		$scan  = self::$scandir ?? static fn ( string $d ) => @\scandir( $d );
		$files = $scan( $dir );
		if ( ! $files ) {
			$this->segments_cache      = [];
			$this->segments_cache_time = $now;
			return [];
		}
		$pattern = $this->segment_pattern();
		foreach ( $files as $f ) {
			if ( \preg_match( $pattern, $f, $m ) ) {
				$segments[] = [ 'id' => (int) $m[1], 'size' => @\filesize( "{$dir}/{$f}" ) ?: 0 ];
			}
		}
		\usort( $segments, fn ( $a, $b ) => $a['id'] <=> $b['id'] );
		$this->segments_cache      = $segments;
		$this->segments_cache_time = $now;
		return $segments;
	}

	/** Seam (Log overrides): regex matching a data filename in segment_dir(); group 1 = id. */
	protected function segment_pattern(): string {
		return self::SEGMENT_PATTERN;
	}

	/** Seam (Log overrides): companion-index path for a segment. Partition = {dir}/{seg}.idx. */
	protected function get_index_path( int $segment_id ): string {
		return "{$this->segment_dir()}/{$segment_id}.idx";
	}

	/** Seam (Log overrides): the directory segments live in. Partition = the resolved dir. */
	protected function segment_dir(): string {
		return $this->partition_dir;
	}

	public static function hash_to_partition( string $key, int $num_partitions ): int {
		[ $stripped ] = \explode( '?', $key, 2 );
		return ( \crc32( $stripped ) & 0x7FFFFFFF ) % $num_partitions;
	}

	/**
	 * Lift the PIPE_BUF cap WITHOUT acquiring the per-partition exclusivity lock —
	 * the no-lock sibling of allow_large_writes(). The caller ASSERTS it is this
	 * partition's sole writer (e.g. a worker that already holds its topology lock,
	 * so the offset/snapshot offsetlog it owns has no other writer). Permits
	 * > PIPE_BUF writes and skips the rotate-lock, exactly like allow_large_writes(),
	 * but trusts the caller instead of enforcing exclusivity with a held lock.
	 *
	 * WARRANTY VOID: two concurrent writers + this = silent torn-write corruption,
	 * with no lock to stop the second writer. If you can't guarantee single-writer,
	 * use allow_large_writes() — it ENFORCES it (and throws on a second writer).
	 */
	public function void_warranty(): self {
		$this->allow_large_writes = true;
		$this->warranty_voided    = true;
		return $this;
	}

	/**
	 * Enable companion index files via a custom formatter callback.
	 *
	 * @param callable $callback fn(string $line, array $position, ?array &$data) => string|null. Return null/'' to skip.
	 * @return self
	 */
	public function with_index( callable $callback ): self {
		$this->index_callback = $callback;
		return $this;
	}

	/**
	 * Emit the base config plus this Partition's verb-config, from STATE — the
	 * `allow_large_writes` flag and the `with_index` formatter name. (The index
	 * callback itself can't be dumped; the formatter name is its round-trip form.)
	 */
	public function dump_config(): string {
		$out = parent::dump_config();
		if ( $this->allow_large_writes ) {
			$verb = $this->warranty_voided ? 'void_warranty' : 'allow_large_writes';
			$out .= "cmd {$this->name}:config {$verb}\n";
		}
		if ( null !== $this->index_formatter_name ) {
			$out .= "cmd {$this->name}:config with_index {$this->index_formatter_name}\n";
		}
		return $out;
	}

	/**
	 * Index the newest segment's TAIL by a VALUE field, latest-record-wins.
	 *
	 * Reads at most `$max_bytes` from the END of the NEWEST segment and returns
	 * `key => VALUE` for the LAST record carrying each distinct `$key_field`.
	 * Records append chronologically, so the tail holds the most recent ones; a
	 * producer that writes every key on a short interval (TopicProbe: every 15s)
	 * keeps every active key present. A bounded tail read is cheaper than the
	 * whole segment. A leading partial line (the tail may start mid-record) is
	 * dropped; records whose key is missing/empty/non-string are skipped.
	 *
	 * Scope caveat: only the newest segment is read, so a key whose latest record
	 * predates the last rotation — a producer silent for longer than the newest
	 * segment currently spans, or, transiently, every key for the seconds right
	 * after a rotation until the next sweep repopulates the fresh segment — is
	 * absent. Intended for "currently-active" state, not a full historical sweep.
	 *
	 * @param string     $dir       The partition dir.
	 * @param int|string $key_field VALUE field to index by (an int for a positional record).
	 * @param int        $max_bytes Max tail bytes to scan (default 128 KiB).
	 * @return array<string,array<mixed>> key → the latest record's VALUE.
	 */
	public static function read_tail_index_by( string $dir, int|string $key_field, int $max_bytes = 131072 ): array {
		$index = [];
		try {
			$log = new self();
			$log->arguments( $dir );
			$segments = $log->get_segments( true );
			if ( empty( $segments ) ) {
				return [];
			}
			$newest = \end( $segments );
			$size   = $newest['size'];
			$offset = $size > $max_bytes ? $size - $max_bytes : 0;
			$bytes  = $log->read_at( $newest['id'], $offset, $size - $offset );
			if ( '' === $bytes ) {
				return [];
			}
			// A non-zero start may land mid-record; drop the partial leading line.
			if ( $offset > 0 ) {
				$nl    = \strpos( $bytes, "\n" );
				$bytes = false === $nl ? '' : \substr( $bytes, $nl + 1 );
			}
			foreach ( \explode( "\n", $bytes ) as $line ) {
				if ( '' === $line ) {
					continue;
				}
				$value = Message::unpacked( $line )[ Message::VALUE ] ?? null;
				if ( ! \is_array( $value ) ) {
					continue;
				}
				$key = $value[ $key_field ] ?? '';
				if ( \is_string( $key ) && '' !== $key ) {
					$index[ $key ] = $value; // chronological → last wins
				}
			}
			return $index;
		} catch ( \Throwable $e ) {
			return [];
		}
	}

	/**
	 * Read the latest committed record's VALUE from an offsetlog directory.
	 *
	 * The offsetlog is a flat segmented-log dir; this opens it at $offset_dir,
	 * reads the last non-empty line of the newest segment, unpacks the packed Message,
	 * and returns its VALUE (a decoded JSON object), or null if empty/unreadable.
	 *
	 * @api Public substrate primitive for dashboard/external consumers that read an
	 *      offsetlog snapshot (e.g. a Service_CI serving dashboard state). No
	 *      in-substrate caller, so this is marked API to keep the deadcode gate honest.
	 *
	 * @param string $offset_dir Absolute path to the offset dir (e.g. {base}/offsets/firehose.p0).
	 * @return array<string,mixed>|null The newest record's VALUE, or null.
	 */
	public static function read_latest_value_at( string $offset_dir ): ?array {
		try {
			$offsetlog = new self();
			$offsetlog->arguments( $offset_dir );
			$segments = $offsetlog->get_segments( true );
			if ( empty( $segments ) ) {
				return null;
			}
			$newest = \end( $segments );
			$bytes  = $offsetlog->read_at( $newest['id'], 0, $newest['size'] );
			if ( '' === $bytes ) {
				return null;
			}
			$lines = \array_filter( \explode( "\n", $bytes ), static fn ( $l ) => '' !== $l );
			if ( empty( $lines ) ) {
				return null;
			}
			$value = Message::unpacked( \end( $lines ) )[ Message::VALUE ] ?? null;
			if ( ! \is_array( $value ) ) {
				return null;
			}
			/** @var array<string,mixed> $value The offsetlog VALUE is a decoded JSON object (string keys). */
			return $value;
		} catch ( \Throwable $e ) {
			return null;
		}
	}

	/**
	 * Glob a family of snapshot-offsetlog dirs and flatten their latest cached item lists.
	 *
	 * For every dir matching `$offsets_dir/$glob`, read the newest committed record's VALUE
	 * (via read_latest_value_at), descend `VALUE[$cache_key][$items_key]`, and concatenate the
	 * array-shaped items into one list. The per-dir read is fault-tolerant: a missing cache,
	 * a non-array items list, or a non-array item is silently skipped. Callers memoize per
	 * request — this re-globs and re-reads every call.
	 *
	 * @api Public substrate primitive: a Service_CI that fans a digest snapshot across
	 *      partitions (e.g. the example AI-newsletter insights demo) reads its accumulated
	 *      items through this instead of re-implementing the glob + cache descent.
	 *
	 * @param string $offsets_dir Absolute path to the offsets base dir holding the snapshot dirs.
	 * @param string $glob        A glob (relative to $offsets_dir) selecting the snapshot dirs, e.g. `scored.p*`.
	 * @param string $cache_key   VALUE key holding the cache object. Default `cache`.
	 * @param string $items_key   Cache key holding the items list. Default `items`.
	 * @return array<int,array<array-key,mixed>> The flattened, array-shaped items across all matched dirs.
	 */
	public static function read_latest_snapshot_cache(
		string $offsets_dir,
		string $glob,
		string $cache_key = 'cache',
		string $items_key = 'items'
	): array {
		$dirs = \glob( \rtrim( $offsets_dir, '/' ) . '/' . $glob, \GLOB_ONLYDIR );
		if ( false === $dirs || [] === $dirs ) {
			return [];
		}
		$items = [];
		foreach ( $dirs as $dir ) {
			$value = self::read_latest_value_at( $dir );
			$cache = \is_array( $value ) && \is_array( $value[ $cache_key ] ?? null ) ? $value[ $cache_key ] : [];
			$list  = $cache[ $items_key ] ?? null;
			if ( ! \is_array( $list ) ) {
				continue;
			}
			foreach ( $list as $item ) {
				if ( \is_array( $item ) ) {
					$items[] = $item;
				}
			}
		}
		return $items;
	}

	/** Topology console manifest: palette entry + ctor form + verb forms. */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'I/O',
			'description' => 'Append-only segmented log; data file + offset index per partition.',
			'arguments'   => [
				[ 'name' => 'dir',          'type' => 'string', 'required' => true ],
				[ 'name' => 'segment_size', 'type' => 'int',    'default'  => self::DEFAULT_SEGMENT_SIZE ],
				[ 'name' => 'num_segments', 'type' => 'int',    'default'  => self::DEFAULT_NUM_SEGMENTS ],
				[ 'name' => 'max_lifespan', 'type' => 'int',    'default'  => self::DEFAULT_MAX_LIFESPAN ],
			],
			'commands'    => [
				[
					'name'        => 'allow_large_writes',
					'description' => 'Lift the 4KB PIPE_BUF cap; acquire per-partition write lock.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_allow_large_writes( $interpreter ),
				],
				[
					'name'        => 'void_warranty',
					'description' => 'Lift the 4KB PIPE_BUF cap with NO write lock — caller asserts single-writer (corrupts under concurrent writers; use allow_large_writes otherwise).',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_void_warranty( $interpreter ),
				],
				[
					'name'        => 'with_index',
					'description' => 'Use a named line-formatter for the companion index file.',
					'args'        => [
						[ 'name' => 'formatter', 'type' => 'formatter_name', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $interpreter, string $args ): string => self::cmd_with_index( $interpreter, $args ),
				],
			],
			'has_target'  => false,
		] );
	}
	/**
	 * `allow_large_writes` verb handler — lift the 4KB cap on the patron + acquire its write lock.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_allow_large_writes( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->allow_large_writes();
		return 'ok';
	}

	/**
	 * `void_warranty` verb handler — lift the 4KB cap with NO lock (caller asserts single-writer).
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_void_warranty( Command_Interpreter_Node $interpreter ): string {
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->void_warranty();
		return 'ok';
	}

	/**
	 * `with_index` verb handler — set the patron's companion-index line-formatter by name.
	 *
	 * @param Command_Interpreter_Node $interpreter Verb argument.
	 * @param string $args Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_with_index( Command_Interpreter_Node $interpreter, string $args ): string {
		$args = \trim( $args );
		if ( '' === $args ) {
			return 'usage: with_index <formatter_name>';
		}
		$callable = Formatters::resolve( $args );
		if ( null === $callable ) {
			return "unknown formatter: $args";
		}
		/** @var self $patron */
		$patron = $interpreter->patron();
		$patron->with_index( $callable );
		$patron->index_formatter_name = $args;
		return 'ok';
	}

}
