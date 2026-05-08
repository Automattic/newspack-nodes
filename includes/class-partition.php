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
	public const SEGMENT_CACHE_TTL    = 0.25;
	public const SEGMENT_PATTERN      = '/^(\d+)\.log$/';

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
	 * Write a line to the current segment + companion .idx entry.
	 *
	 * @param string $line Line to append (caller includes trailing newline).
	 * @return bool True on success, false if dropped (size limit) or write failed.
	 */
	public function write( string $line ): bool {
		$max = $this->allow_large_writes ? self::MAX_LARGE_LINE_SIZE : self::MAX_LINE_SIZE;
		if ( \strlen( $line ) > $max ) {
			return false;
		}

		if ( null === $this->current_segment_id ) {
			$this->init_current_segment();
		}

		if ( $this->allow_large_writes ) {
			return (bool) $this->write_lock->with_lock( fn () => $this->do_write( $line ) );
		}
		return $this->do_write( $line );
	}

	/**
	 * Append to the current segment + write companion index entry.
	 * Caller must have set $this->current_* state.
	 *
	 * @param string $line Bytes to append.
	 * @return bool True on success.
	 */
	protected function do_write( string $line ): bool {
		if ( $this->current_size + \strlen( $line ) > $this->segment_size ) {
			$this->rotate_segment();
		}

		$fh = $this->get_handle();
		if ( null === $fh ) {
			return false;
		}
		$offset = $this->current_size;
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		$bytes = @\fwrite( $fh, $line );
		if ( false === $bytes ) {
			return false;
		}
		$this->current_size += $bytes;

		if ( \is_resource( $this->idx_fh ) ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
			@\fwrite( $this->idx_fh, \pack( 'NN', $this->current_segment_id, $offset ) );
		}

		// Keep cached size fresh so a stale cache hit doesn't lie about the active segment.
		// If the active segment isn't in the cache yet (first write materialized it), add it.
		if ( null !== $this->segments_cache ) {
			$found = false;
			foreach ( $this->segments_cache as $i => $s ) {
				if ( $s['id'] === $this->current_segment_id ) {
					$this->segments_cache[ $i ]['size'] = $this->current_size;
					$found = true;
					break;
				}
			}
			if ( ! $found ) {
				$this->segments_cache[] = [ 'id' => $this->current_segment_id, 'size' => $this->current_size ];
			}
		}

		return true;
	}

	/**
	 * Rotate to a new segment when the current one is full.
	 * Closes the active handles, bumps segment_id, resets size, invalidates cache.
	 */
	protected function rotate_segment(): void {
		$this->close_handle();
		++$this->current_segment_id;
		$this->current_size     = 0;
		$this->current_log_path = "{$this->partition_dir}/{$this->current_segment_id}.log";
		$this->current_idx_path = "{$this->partition_dir}/{$this->current_segment_id}.idx";
		$this->segments_cache   = null;
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
	 * @param int $segment_id Segment to read from.
	 * @param int $offset     Byte offset within segment.
	 * @param int $length     Number of bytes to read.
	 * @return string Bytes read; empty string on missing file or read failure.
	 */
	public function read_at( int $segment_id, int $offset, int $length ): string {
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
	 * Each entry is 8 bytes packed as two big-endian uint32s: segment_id, offset.
	 *
	 * @param callable $cb fn(int $segment_id, int $offset): mixed
	 */
	public function scan_index( callable $cb ): void {
		$segments = $this->get_segments();
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
			$len = \strlen( $idx );
			for ( $i = 0; $i < $len; $i += 8 ) {
				$entry = \substr( $idx, $i, 8 );
				if ( \strlen( $entry ) !== 8 ) {
					break;
				}
				[ , $seg, $off ] = \unpack( 'N2', $entry );
				$cb( $seg, $off );
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
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fopen
			$idx_fh = @\fopen( $this->current_idx_path, 'a' );
			$this->idx_fh = ( false === $idx_fh ) ? null : $idx_fh;
		}
		return $this->fh;
	}
}
