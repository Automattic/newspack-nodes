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
	public const DEFAULT_SEGMENT_SIZE = 67108864;
	public const DEFAULT_NUM_SEGMENTS = 4;
	public const DEFAULT_MAX_LIFESPAN = 86400;
	public const MAX_LINE_SIZE        = 4096;
	public const MAX_LARGE_LINE_SIZE  = 10485760;
	public const SEGMENT_CACHE_TTL    = 0.25;
	public const SEGMENT_PATTERN      = '/^(\d+)\.log$/';

	/** Inter-process rotation lock TTL: anything older counts as stale. */
	public const ROTATE_LOCK_TTL_SECONDS = 5;

	public const MAX_PARTIAL_WRITE_ATTEMPTS = 5;

	public const DRIFT_RESCAN_INTERVAL_SECONDS = 1.0;

	protected string $base_dir      = '';
	protected int $partition        = 0;
	protected int $segment_size     = self::DEFAULT_SEGMENT_SIZE;
	protected int $num_segments     = self::DEFAULT_NUM_SEGMENTS;
	protected int $max_lifespan     = self::DEFAULT_MAX_LIFESPAN;

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

	protected ?array $segments_cache = null;
	protected float $segments_cache_time = 0.0;

	protected bool $allow_large_writes = false;
	/** Formatter name set via the `with_index` verb — the round-trippable form of the index callback (which itself can't be dumped). */
	protected ?string $index_formatter_name = null;
	protected ?Lock_Node $write_lock = null;
	protected ?Timer_Node $heartbeat_timer = null;
	protected int $lock_stale_timeout = 0;
	protected float $last_lock_heartbeat = 0.0;

	protected float $last_segment_check = 0.0;

	/** @var callable|null fn(string $line, array $position, ?array &$data) => string|null */
	protected $index_callback = null;

	/** @var string Packed messages awaiting one PIPE_BUF-atomic syswrite. */
	protected string $batch = '';

	/** @var list<array{packed:string,len:int,data:mixed}> Flushed in lockstep with $batch. */
	protected array $batch_index_args = [];

	/**
	 * Tachikoma-parity: no-arg ctor. Positional config arrives via `arguments()`,
	 * which the base setter parses against `node_schema()['arguments']`. The
	 * override below re-normalizes after that walk and re-derives partition_dir.
	 */
	public function __construct() {
		// Chains Timer_Node → Node; the base ctor auto-wires the sibling :config
		// interpreter from node_schema()['commands'] (handlers are static + read $interpreter->patron()
		// lazily, so running before arguments() populates the props below is fine).
		parent::__construct();
	}

	/**
	 * Setter chains through the base schema walker (which assigns base_dir,
	 * partition, segment_size, num_segments, max_lifespan from positional
	 * tokens or schema defaults), then normalizes the assigned values and
	 * re-derives partition_dir. Getter returns the last-set raw string.
	 *
	 * @param string|null $args
	 * @return string
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return parent::arguments();
		}
		$result = parent::arguments( $args );
		// Empty-string args mirrors the base setter's no-op (no schema walk,
		// no token-driven assignment): don't re-derive partition_dir from
		// declaration-default props (would yield '/p0' at filesystem root).
		if ( '' === $args ) {
			return $result;
		}
		$this->base_dir      = \rtrim( $this->base_dir, '/' );
		$this->segment_size  = \max( 1, $this->segment_size );
		$this->num_segments  = \max( 2, $this->num_segments );
		$this->max_lifespan  = \max( 0, $this->max_lifespan );
		$this->partition_dir = "{$this->base_dir}/p{$this->partition}";
		return $result;
	}

	/** Timer fire: drain the batch at the end of the current event-loop iteration. */
	protected function fire(): void {
		$this->flush();
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
	 * Node entry point: pack the message and append to the current segment.
	 *
	 * @param array $message Reference; not mutated.
	 */
	public function fill( array &$message ): void {
		++$this->counter;

		// No-event-loop heartbeat: heartbeat() returns false if ownership was stolen, so throw.
		if ( $this->allow_large_writes && null === $this->heartbeat_timer ) {
			$now = \microtime( true );
			if ( $now - $this->last_lock_heartbeat >= $this->lock_stale_timeout / 3.0 ) {
				if ( ! $this->write_lock->heartbeat() ) {
					throw new \RuntimeException(
						\esc_html(
							"Partition: write lock at {$this->partition_dir}/write.lock.d "
							. 'no longer owned (stolen via stale-takeover); cannot continue.'
						)
					);
				}
				$this->last_lock_heartbeat = $now;
			}
		}

		// Size cap is on the final packed bytes (not VALUE alone) — that's what hits PIPE_BUF.
		$packed = Message::packed( $message ) . "\n";
		$max    = $this->allow_large_writes ? self::MAX_LARGE_LINE_SIZE : self::MAX_LINE_SIZE;
		$size   = \strlen( $packed );
		if ( $size > $max ) {
			$this->set_state(
				'DROPPED',
				[ 'reason' => 'oversize', 'size' => $size, 'max' => $max ]
			);
			return;
		}

		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}

		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}

		$len = \strlen( $packed );
		$this->maybe_rescan_segments();

		$data = null;

		// Large messages bypass the batch; flush pending batch first to preserve ordering.
		if ( $len > self::MAX_LINE_SIZE ) {
			$this->flush();
			if ( $this->current_size + $len > $this->segment_size ) {
				$this->rotate_segment();
			}
			$fh = $this->get_handle();
			if ( null === $fh ) {
				return;
			}
			$offset = $this->current_size;
			if ( ! $this->loop_fwrite( $fh, $packed ) ) {
				return;
			}
			$this->write_index_entry( $packed, $offset, $len, $data );
			$this->touch_segments_cache();
			return;
		}

		// Flush if this message would push the batch over PIPE_BUF — keeps syswrites atomic.
		if ( '' !== $this->batch && \strlen( $this->batch ) + $len > self::MAX_LINE_SIZE ) {
			$this->flush();
		}

		if ( $this->current_size + $len > $this->segment_size ) {
			$this->rotate_segment();
		}

		$this->batch              .= $packed;
		$this->batch_index_args[]  = [
			'packed' => $packed,
			'len'    => $len,
			'data'   => $data,
		];

		// 0-delay one-shot flush at the end of this event-loop iteration.
		$this->set_timer( 0, true );
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
		$start_offset = $this->current_size;
		if ( ! $this->loop_fwrite( $fh, $batch_bytes ) ) {
			return;
		}

		$offset = $start_offset;
		foreach ( $batch_args as $item ) {
			$this->write_index_entry( $item['packed'], $offset, $item['len'], $item['data'] );
			$offset += $item['len'];
		}

		$this->touch_segments_cache();
	}

	/** Write one companion-index entry for a packed message at $offset. */
	private function write_index_entry( string $packed, int $offset, int $len, $data ): void {
		if ( null !== $this->index_callback ) {
			$position = [
				'segment_id' => $this->current_segment_id,
				'offset'     => $offset,
				'length'     => $len,
			];
			try {
				$entry = ( $this->index_callback )( $packed, $position, $data );
				if ( null !== $entry && '' !== $entry && \is_resource( $this->idx_fh ) ) {
					// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
					@\fwrite( $this->idx_fh, $entry . "\n" );
				}
			} catch ( \Throwable $e ) {
				$this->print_less_often( 'Partition: index callback threw: ' . $e->getMessage() );
			}
			return;
		}
		if ( \is_resource( $this->idx_fh ) ) {
			// Default binary 8-byte format: <segment_id, offset> as two big-endian uint32s.
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
			@\fwrite( $this->idx_fh, \pack( 'NN', $this->current_segment_id, $offset ) );
		}
	}

	public function __destruct() {
		// Flush residual batched messages so request-scope writes aren't GC'd unwritten.
		$this->flush();
		$this->close_handle();
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

	public static function hash_to_partition( string $key, int $num_partitions ): int {
		[ $stripped ] = \explode( '?', $key, 2 );
		return ( \crc32( $stripped ) & 0x7FFFFFFF ) % $num_partitions;
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
		$lock          = new Lock_Node( "{$this->partition_dir}/write.lock.d", $stale_timeout );

		// Drain active: wire Lock + heartbeat Timer. Request-scope: drive heartbeat from fill().
		$ef_running = Event_Framework::instance()->is_running();
		if ( $ef_running ) {
			$lock->name( "{$this->name}:lock" );
			$lock->sink( $this->sink );
			// Patron-linked so dump_metadata hides it from the topology console canvas.
			$lock->patron( $this );
		}

		if ( ! $lock->acquire( $max_wait_ms ) ) {
			throw new \RuntimeException(
				\esc_html(
					"Partition::allow_large_writes() failed to acquire write lock at "
					. "{$this->partition_dir}/write.lock.d after {$max_wait_ms}ms — another live writer holds it. "
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
			$this->heartbeat_timer->sink( $this->write_lock );
			$this->heartbeat_timer->set_key( 'heartbeat' );
			$this->heartbeat_timer->set_timer( (int) ( $stale_timeout * 1000 / 3 ) );
			$this->heartbeat_timer->patron( $this );
		}

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
			$out .= "cmd {$this->name}:config allow_large_writes\n";
		}
		if ( null !== $this->index_formatter_name ) {
			$out .= "cmd {$this->name}:config with_index {$this->index_formatter_name}\n";
		}
		return $out;
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
			$this->current_log_path   = "{$this->partition_dir}/{$this->current_segment_id}.log";
			$this->current_idx_path   = "{$this->partition_dir}/{$this->current_segment_id}.idx";
		}
	}

	/**
	 * Loop fwrite up to MAX_PARTIAL_WRITE_ATTEMPTS to handle short writes.
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
					$this->print_less_often( 'Partition: fwrite stalled (' . $attempts . " attempts) for {$this->current_log_path}" );
					return false;
				}
				continue;
			}
			$this->current_size  += $written;
			$this->bytes_written += $written;
			$remaining            = \substr( $remaining, $written );
		}
		return true;
	}

	/**
	 * Mirror current_size into segments_cache so a stale hit doesn't misreport the active segment.
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
		// Force-refresh — the cache may pre-date a peer's rotation.
		$segments = $this->get_segments( true );

		if ( ! empty( $segments ) ) {
			$newest = \end( $segments );
			if ( $newest['size'] < $this->segment_size ) {
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

		// Materialize the empty file so get_handle()'s missing-file guard doesn't reset to segment 0.
		if ( ! \is_dir( $this->partition_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $this->partition_dir, 0755, true );
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_touch, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_touch
		if ( ! @\touch( $this->current_log_path ) ) {
			$this->print_less_often( "Partition: touch() failed for {$this->current_log_path}" );
		}

		$this->cleanup_segments();

		$this->set_state( 'SEGMENT', $this->current_segment_id );
	}

	/**
	 * AND-gated retention: delete oldest segments only when count > num_segments
	 * AND (now - mtime) >= max_lifespan.
	 */
	public function cleanup_segments(): void {
		$segments       = $this->get_segments( true );
		$count          = \count( $segments );
		$initial_count  = $count;
		$now            = \time();

		while ( $count > $this->num_segments ) {
			$oldest = $segments[0];
			$path   = "{$this->partition_dir}/{$oldest['id']}.log";
			$mtime  = @\filemtime( $path );
			if ( false === $mtime || ( $now - $mtime ) < $this->max_lifespan ) {
				break;
			}
			// Partition's segment directory is base_dir-relative — not WP-managed.
			// phpcs:disable WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
			@\unlink( $path );
			@\unlink( "{$this->partition_dir}/{$oldest['id']}.idx" );
			// phpcs:enable
			\array_shift( $segments );
			--$count;
		}
		$this->segments_cache = null;

		$deleted = $initial_count - $count;
		if ( $deleted > 0 ) {
			$this->set_state( 'CLEANUP', [ 'deleted' => $deleted, 'alive' => $count ] );
		}
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

	/**
	 * Walk every .idx entry across all segments and invoke the callback per entry.
	 *
	 * Callback signature depends on with_index(): default binary →
	 * fn(int $segment_id, int $offset); custom JSONL → fn(string $line, int $segment_id).
	 * Return false from the callback to terminate the scan early.
	 *
	 * @param callable $cb           Per-entry callback.
	 * @param bool     $newest_first Iterate newest segment first when true.
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

			// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
			$idx = @\file_get_contents( $idx_path );
			if ( false === $idx ) {
				continue;
			}

			if ( null !== $this->index_callback ) {
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
	 * @return resource|null Log handle, or null on open failure.
	 */
	protected function get_handle() {
		if ( ! \is_dir( $this->partition_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $this->partition_dir, 0755, true );
			// Whole tree got wiped; reset from disk (lands at segment 0).
			$this->init_current_segment();
		} elseif ( null !== $this->current_log_path && ! \file_exists( $this->current_log_path ) ) {
			// Active log file disappeared underneath us — re-init from disk.
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

			// Single-writer mode: disable PHP's 8KB buffer so readers see writes immediately.
			if ( $this->allow_large_writes ) {
				\stream_set_write_buffer( $this->fh, 0 );
			}

			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
			$idx_fh       = @\fopen( $this->current_idx_path, 'a' );
			$this->idx_fh = ( false === $idx_fh ) ? null : $idx_fh;
		}
		return $this->fh;
	}

	/** Topology console manifest: palette entry + ctor form + verb forms. */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'I/O',
			'description' => 'Append-only segmented log; data file + offset index per partition.',
			'arguments'        => [
				[ 'name' => 'base_dir',     'type' => 'string', 'required' => true ],
				[ 'name' => 'partition',    'type' => 'int',    'required' => true ],
				[ 'name' => 'segment_size', 'type' => 'int',    'default' => self::DEFAULT_SEGMENT_SIZE ],
				[ 'name' => 'num_segments', 'type' => 'int',    'default' => self::DEFAULT_NUM_SEGMENTS ],
				[ 'name' => 'max_lifespan', 'type' => 'int',    'default' => self::DEFAULT_MAX_LIFESPAN ],
			],
			'commands'       => [
				[
					'name'        => 'allow_large_writes',
					'description' => 'Lift the 4KB PIPE_BUF cap; acquire per-partition write lock.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, string $args ): string {
						/** @var self $patron */
						$patron = $interpreter->patron();
						$patron->allow_large_writes();
						return 'ok';
					},
				],
				[
					'name'        => 'with_index',
					'description' => 'Use a named line-formatter for the companion index file.',
					'args'        => [
						[ 'name' => 'formatter', 'type' => 'formatter_name', 'required' => true ],
					],
					'handler'     => static function ( Command_Interpreter_Node $interpreter, string $args ): string {
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
					},
				],
			],
			'has_target'  => false,
		] );
	}
}
