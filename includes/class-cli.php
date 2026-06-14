<?php
/**
 * Cli: helper methods backing the WP-CLI commands (pure I/O against on-disk + memcache state).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class CLI {
	private string $base_dir;

	public function __construct( string $base_dir ) {
		$this->base_dir = \rtrim( $base_dir, '/' );
	}

	/**
	 * Resolve IPC paths for a `{type}.p{N}` reader id; verifies the worker's lock dir exists.
	 *
	 * @param string $worker_id Worker id in `{type}.p{N}` form.
	 * @return array{input:string,output:string,type:string,partition:int}
	 * @throws \InvalidArgumentException If worker_id can't be parsed or no matching lock dir exists.
	 */
	public function attach_to_worker( string $worker_id ): array {
		[ $type, $partition ] = self::parse_worker_id( $worker_id );
		$lock_dir             = "{$this->base_dir}/locks/{$worker_id}.lock.d";
		if ( ! \is_dir( $lock_dir ) ) {
			throw new \InvalidArgumentException(
				\esc_html( "no worker '{$worker_id}' (run `wp nodes ls` to list active workers)" )
			);
		}
		return [
			'input'     => "{$this->base_dir}/ipc/{$worker_id}/input",
			'output'    => "{$this->base_dir}/ipc/{$worker_id}/output",
			'type'      => $type,
			'partition' => $partition,
		];
	}

	/**
	 * Parse `{type}.p{N}` into [type, partition].
	 *
	 * @param string $worker_id Worker id.
	 * @return array{0:string,1:int}
	 * @throws \InvalidArgumentException If worker_id can't be parsed.
	 */
	public static function parse_worker_id( string $worker_id ): array {
		if ( ! \preg_match( '/^(.+)\.p(\d+)$/', $worker_id, $m ) ) {
			throw new \InvalidArgumentException( \esc_html( "invalid reader id: $worker_id (expected {type}.p{N})" ) );
		}
		return [ $m[1], (int) $m[2] ];
	}

	/**
	 * Read a live worker-cursor position from memcache.
	 *
	 * Hits the same `np:pos:{host}:{source_basename}.p{N}` per-reader key
	 * Consumer_Node publishes — derives the source basename from the worker's
	 * recorded input, falling back to the conventional `firehose` when none yet.
	 *
	 * @param object $cache    Anything with a `get(string)` method; null to skip.
	 * @param string $type     Worker type.
	 * @param int    $partition Partition index.
	 * @return array{seg:int,off:int,ts?:int}|null Position or null if not cached / unreachable.
	 */
	public function live_position( ?object $cache, string $type, int $partition ): ?array {
		if ( null === $cache || ! \method_exists( $cache, 'get' ) ) {
			return null;
		}
		$basename = $this->input_basename( $type, $partition ) ?: 'firehose';
		$host     = \gethostname() ?: 'unknown';
		try {
			$value = $cache->get( Consumer_Node::position_key( $host, "{$basename}.p{$partition}" ) );
		} catch ( \Throwable $e ) {
			return null;
		}
		return self::normalize_position( $value );
	}

	/**
	 * Live cursor for a specific Consumer, keyed by its offset-dir identity
	 * (`{source_basename}.p{N}`) — the per-reader key `Consumer_Node` publishes.
	 * Unlike live_position(), this addresses ONE Consumer, not a whole worker type.
	 *
	 * @param object|null $cache           `\Memcached`-shaped (or null to skip).
	 * @param string      $offset_dir_name e.g. `firehose.job-router.p0`.
	 * @return array{seg:int,off:int,ts?:int}|null
	 */
	public function live_position_for( ?object $cache, string $offset_dir_name ): ?array {
		if ( null === $cache || ! \method_exists( $cache, 'get' ) ) {
			return null;
		}
		$host = \gethostname() ?: 'unknown';
		try {
			$value = $cache->get( Consumer_Node::position_key( $host, $offset_dir_name ) );
		} catch ( \Throwable $e ) {
			return null;
		}
		return self::normalize_position( $value );
	}

	/**
	 * Coerce a raw memcache/offsetlog position value to `{seg,off,ts}` ints, or
	 * null when it's not a usable position record.
	 *
	 * @param mixed $value Raw cache value.
	 * @return array{seg:int,off:int,ts:int}|null
	 */
	private static function normalize_position( $value ): ?array {
		if ( ! \is_array( $value ) || ! isset( $value['seg'], $value['off'] ) ) {
			return null;
		}
		$seg = $value['seg'];
		$off = $value['off'];
		$ts  = $value['ts'] ?? 0;
		return [
			'seg' => \is_numeric( $seg ) ? (int) $seg : 0,
			'off' => \is_numeric( $off ) ? (int) $off : 0,
			'ts'  => \is_numeric( $ts ) ? (int) $ts : 0,
		];
	}

	/**
	 * The input-log basename a worker drains, read from its offsetlog's latest
	 * checkpoint (`source_basename`). Empty string if no offsetlog yet — lets
	 * callers locate the worker's partition dir without assuming `firehose.log`.
	 *
	 * @param string $type      Worker type.
	 * @param int    $partition Partition index.
	 */
	public function input_basename( string $type, int $partition ): string {
		$offset_dir = "{$this->base_dir}/offsets/{$type}.p{$partition}/p0";
		if ( ! \is_dir( $offset_dir ) ) {
			return '';
		}
		$files = @\scandir( $offset_dir );
		if ( false === $files ) {
			return '';
		}
		$segments = [];
		foreach ( $files as $f ) {
			if ( \preg_match( '/^(\d+)\.log$/', $f, $m ) ) {
				$segments[] = (int) $m[1];
			}
		}
		if ( empty( $segments ) ) {
			return '';
		}
		\sort( $segments );
		$path = "{$offset_dir}/" . \end( $segments ) . '.log';
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$bytes = @\file_get_contents( $path );
		if ( false === $bytes || '' === $bytes ) {
			return '';
		}
		$lines = \array_filter( \explode( "\n", \rtrim( $bytes, "\n" ) ), static fn ( $l ) => '' !== $l );
		if ( empty( $lines ) ) {
			return '';
		}
		$last = \json_decode( \end( $lines ), true );
		if ( ! \is_array( $last ) || ! isset( $last['source_basename'] ) ) {
			return '';
		}
		$basename = $last['source_basename'];
		return \is_scalar( $basename ) ? (string) $basename : '';
	}

	public function base_dir(): string {
		return $this->base_dir;
	}

	/**
	 * Enumerate worker lock dirs and report each one's staleness.
	 *
	 * @return array<int,array{type:string,partition:int,heartbeat_at:int,stale:bool}>
	 */
	public function ls_workers(): array {
		$locks_dir = "{$this->base_dir}/locks";
		if ( ! \is_dir( $locks_dir ) ) {
			return [];
		}
		$now     = \time();
		$workers = [];
		foreach ( \scandir( $locks_dir ) ?: [] as $entry ) {
			if ( ! \preg_match( '/^(.+)\.p(\d+)\.lock\.d$/', $entry, $m ) ) {
				continue;
			}
			$type      = $m[1];
			$partition = (int) $m[2];
			$hb        = "{$locks_dir}/{$entry}/heartbeat";
			$mtime     = @\filemtime( $hb );
			$stale     = ( false === $mtime || ( $now - $mtime ) > Lock_Node::STALE_TIMEOUT );
			$workers[] = [
				'type'         => $type,
				'partition'    => $partition,
				'heartbeat_at' => $mtime ?: 0,
				'stale'        => $stale,
			];
		}
		\usort( $workers, fn ( $a, $b ) =>
			[ $a['type'], $a['partition'] ] <=> [ $b['type'], $b['partition'] ]
		);
		return $workers;
	}

	/**
	 * Request restart for one or more worker groups by dropping a `restart` flag.
	 *
	 * @param array<int, array<string, mixed>> $workers   List of `[type=>str, partition=>int]`.
	 * @param array<string, bool>              $filter    Optional `[type => bool]`; empty or 'all' = wildcard.
	 * @param int                              $partition Only this partition if >= 0; -1 = any.
	 * @return int Number of restart-flag files written.
	 */
	public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int {
		$restarted = 0;
		$wildcard  = empty( $filter ) || isset( $filter['all'] );

		foreach ( $workers as $w ) {
			$type_raw = $w['type'] ?? '';
			$type     = \is_scalar( $type_raw ) ? (string) $type_raw : '';
			$p_raw    = $w['partition'] ?? 0;
			$p        = \is_numeric( $p_raw ) ? (int) $p_raw : 0;
			if ( '' === $type ) {
				continue;
			}
			if ( ! $wildcard && empty( $filter[ $type ] ) ) {
				continue;
			}
			if ( $partition >= 0 && $p !== $partition ) {
				continue;
			}
			if ( Lock_Node::request_restart_at( "{$this->base_dir}/locks/{$type}.p{$p}.lock.d" ) ) {
				++$restarted;
			}
		}
		return $restarted;
	}

	/**
	 * Drop a restart flag at the supervisor's singleton lock dir.
	 *
	 * @return bool True when the flag was written.
	 */
	public function restart_supervisor(): bool {
		return Lock_Node::request_restart_at( "{$this->base_dir}/locks/supervisor.lock.d" );
	}

	/**
	 * Sum bytes still ahead of a cursor across a partition's segments (the "Behind" column).
	 *
	 * @param string $partition_dir Absolute path to the partition directory.
	 * @param int    $cursor_seg    Cursor segment id.
	 * @param int    $cursor_offset Cursor offset within $cursor_seg.
	 * @return int Bytes remaining (0 if caught up or partition missing).
	 */
	public static function calculate_behind( string $partition_dir, int $cursor_seg, int $cursor_offset ): int {
		if ( ! \is_dir( $partition_dir ) ) {
			return 0;
		}
		$files = @\scandir( $partition_dir );
		if ( false === $files ) {
			return 0;
		}
		$segments = [];
		foreach ( $files as $file ) {
			if ( \preg_match( '/^(\d+)\.log$/', $file, $m ) ) {
				$seg_id = (int) $m[1];
				$size   = @\filesize( "{$partition_dir}/{$file}" );
				if ( false !== $size ) {
					$segments[ $seg_id ] = $size;
				}
			}
		}
		if ( empty( $segments ) ) {
			return 0;
		}
		\ksort( $segments );

		$behind        = 0;
		$found_current = false;
		foreach ( $segments as $seg_id => $size ) {
			if ( $seg_id === $cursor_seg ) {
				$found_current = true;
				$remaining     = $size - $cursor_offset;
				if ( $remaining > 0 ) {
					$behind += $remaining;
				}
			} elseif ( $found_current || $seg_id > $cursor_seg ) {
				$behind += $size;
			}
		}
		return $behind;
	}

	/**
	 * Format byte counts compactly for the Behind column of `wp nodes status`.
	 */
	public static function format_bytes( int $bytes ): string {
		if ( $bytes < 1024 ) {
			return $bytes . 'B';
		}
		if ( $bytes < 1024 * 1024 ) {
			return \round( $bytes / 1024, 1 ) . 'KB';
		}
		if ( $bytes < 1024 * 1024 * 1024 ) {
			return \round( $bytes / ( 1024 * 1024 ), 1 ) . 'MB';
		}
		return \round( $bytes / ( 1024 * 1024 * 1024 ), 1 ) . 'GB';
	}

	/**
	 * Format an uptime duration compactly for `wp nodes status`.
	 */
	public static function format_duration( int $seconds ): string {
		if ( $seconds < 60 ) {
			return $seconds . 's';
		}
		if ( $seconds < 3600 ) {
			return \floor( $seconds / 60 ) . 'm';
		}
		if ( $seconds < 86400 ) {
			return \floor( $seconds / 3600 ) . 'h';
		}
		return \floor( $seconds / 86400 ) . 'd';
	}

	/**
	 * Read the latest committed checkpoint VALUE from an offset dir under
	 * `offsets/` (e.g. `firehose.job-router.p0`). The offsetlog is itself a
	 * single-partition Partition (p0); the outer dir name encodes the spoke
	 * partition. Null if empty/unreadable. The checkpoint is a packed Message —
	 * unpacked here (NOT a flat json_decode of the raw line).
	 *
	 * @return array<string,mixed>|null The decoded VALUE object.
	 */
	public function read_offsetlog_entry( string $offset_dir_name ): ?array {
		return Partition_Node::read_latest_value_at( "{$this->base_dir}/offsets/{$offset_dir_name}" );
	}

	/**
	 * One row per active Consumer: scan `offsets/` for `{source_basename}.p{N}`
	 * dirs and read each latest checkpoint. Rows whose checkpoint records no
	 * worker_type are skipped (nothing to attribute them to). This is the
	 * canonical per-Consumer enumeration shared by the Worker Status dashboard
	 * (`Workers_CI_Node`) and `wp nodes status`.
	 *
	 * @return array<int,array{name:string,target:string,targets:array<int,array<string,mixed>>,worker_type:string,source_basename:string,source_log:string,partition:int,seg:int,off:int,ts:float}>
	 */
	public function consumer_rows(): array {
		$offsets_dir = "{$this->base_dir}/offsets";
		if ( ! \is_dir( $offsets_dir ) ) {
			return [];
		}
		$entries = @\scandir( $offsets_dir );
		if ( false === $entries ) {
			return [];
		}
		$rows = [];
		foreach ( $entries as $entry ) {
			if ( '.' === $entry || '..' === $entry ) {
				continue;
			}
			// Expect `{source_basename}.p{N}` directory naming.
			if ( ! \preg_match( '/^(.+)\.p(\d+)$/', $entry, $m ) ) {
				continue;
			}
			$value = $this->read_offsetlog_entry( $entry );
			if ( null === $value ) {
				continue;
			}
			$worker_type = self::scalar_string( $value['worker_type'] ?? '' );
			// Skip entries pre-dating the metadata addition — no worker to attribute to.
			if ( '' === $worker_type ) {
				continue;
			}
			/** @var array<int,array<string,mixed>> $targets Decoded offsetlog `targets`: a list of `{name,…}` objects. */
			$targets = \is_array( $value['targets'] ?? null ) ? $value['targets'] : [];
			$rows[]  = [
				'name'            => self::scalar_string( $value['name']   ?? '' ),
				'target'          => self::scalar_string( $value['target'] ?? '' ),
				'targets'         => $targets,
				'worker_type'     => $worker_type,
				'source_basename' => $m[1],
				'source_log'      => self::scalar_string( $value['source_log'] ?? '' ),
				'partition'       => (int) $m[2],
				'seg'             => self::scalar_int( $value['seg'] ?? 0 ),
				'off'             => self::scalar_int( $value['off'] ?? 0 ),
				'ts'              => self::scalar_float( $value['ts']  ?? 0 ),
			];
		}
		return $rows;
	}

	/**
	 * Coerce a mixed value to string (non-scalar → '').
	 *
	 * @param mixed $v Raw value.
	 */
	private static function scalar_string( $v ): string {
		return \is_scalar( $v ) ? (string) $v : '';
	}

	/**
	 * Coerce a mixed value to int (non-scalar → 0).
	 *
	 * @param mixed $v Raw value.
	 */
	private static function scalar_int( $v ): int {
		return \is_scalar( $v ) ? (int) $v : 0;
	}

	/**
	 * Coerce a mixed value to float (non-scalar → 0.0).
	 *
	 * @param mixed $v Raw value.
	 */
	private static function scalar_float( $v ): float {
		return \is_scalar( $v ) ? (float) $v : 0.0;
	}
}
