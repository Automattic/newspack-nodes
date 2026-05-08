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

class Partition {
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
		$this->segment_size  = \max( 1024, $segment_size );
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

	public function __destruct() {
		$this->close_handle();
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
		if ( null !== $this->segments_cache ) {
			foreach ( $this->segments_cache as $i => $s ) {
				if ( $s['id'] === $this->current_segment_id ) {
					$this->segments_cache[ $i ]['size'] = $this->current_size;
					break;
				}
			}
		}

		return true;
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
