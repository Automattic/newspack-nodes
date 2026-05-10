<?php
/**
 * Cli: helper methods backing the WP-CLI commands.
 *
 * The shape mirrors event-logger's legacy `WorkerCommand` helpers so worker-cli
 * surfaces (run/restart/status/types/reqgrep) share one source of truth:
 *
 *  - `ls_workers()` enumerates lock-dir heartbeats for `wp nodes ls`.
 *  - `attach_to_worker()` resolves IPC paths for `wp nodes cli {reader}`.
 *  - `parse_reader_id()` parses `{type}.p{N}` (public so command classes share it).
 *  - `restart_workers()` writes the restart flag for one type+partition or `all`,
 *    fanning across topologies discovered from the runtime's `newspack_nodes/topologies`
 *    filter (registered via `Bootstrap::expand_workers()`).
 *  - `live_positions()` reads worker-cursor positions from memcache when a
 *    Cache_Interface-shaped instance is supplied. Returns null if memcache is
 *    unreachable so callers can fall back to on-disk offsetlog reads.
 *
 * Capability + nonce checks live in the WP_CLI command classes (`WorkerCliCommand`,
 * `ReqgrepCommand`) — this class is pure I/O against the on-disk + memcache state.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Cli {
	public const STALE_TIMEOUT = 60;

	/**
	 * Default key prefix for worker-cursor positions in memcache. Mirrors the
	 * event-logger plugin convention so reading code can be migrated 1:1.
	 */
	public const POSITION_KEY_PREFIX = 'newspack_nodes:cursor:';

	private string $base_dir;

	public function __construct( string $base_dir ) {
		$this->base_dir = \rtrim( $base_dir, '/' );
	}

	public function base_dir(): string {
		return $this->base_dir;
	}

	/**
	 * Enumerate worker lock dirs under `{base}/locks/` and report each worker's
	 * staleness. Used by `wp nodes ls` and the rich `wp nodes status` table.
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
			$stale     = ( false === $mtime || ( $now - $mtime ) > self::STALE_TIMEOUT );
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
	 * Resolve IPC paths for a `{type}.p{N}` reader id. Caller uses the returned
	 * `input` / `output` as `Partition` paths to drive the REPL pivoted-mode
	 * graph.
	 *
	 * @param string $reader_id Reader id in `{type}.p{N}` form.
	 * @return array{input:string,output:string,type:string,partition:int}
	 * @throws \InvalidArgumentException If reader_id can't be parsed.
	 */
	public function attach_to_worker( string $reader_id ): array {
		[ $type, $partition ] = self::parse_reader_id( $reader_id );
		return [
			'input'     => "{$this->base_dir}/ipc/{$reader_id}/input",
			'output'    => "{$this->base_dir}/ipc/{$reader_id}/output",
			'type'      => $type,
			'partition' => $partition,
		];
	}

	/**
	 * Parse `{type}.p{N}` into [type, partition]. Public so command classes can
	 * validate user input without re-deriving the regex.
	 *
	 * @param string $reader_id Reader id.
	 * @return array{0:string,1:int}
	 * @throws \InvalidArgumentException If reader_id can't be parsed.
	 */
	public static function parse_reader_id( string $reader_id ): array {
		if ( ! \preg_match( '/^(.+)\.p(\d+)$/', $reader_id, $m ) ) {
			throw new \InvalidArgumentException( "invalid reader id: $reader_id (expected {type}.p{N})" );
		}
		return [ $m[1], (int) $m[2] ];
	}

	/**
	 * Request restart for one or more worker groups. Drops a `restart` flag file
	 * into each lock dir; the live holder polls `should_restart()` from its drain
	 * loop and exits cleanly so a fresh process can take over.
	 *
	 * @param array $workers   List of `[type=>str, partition=>int]` (typically from
	 *                          `Bootstrap::expand_workers()`).
	 * @param array $filter    Optional filter `[type => bool]`. If empty, all
	 *                          workers are matched. Use type='all' (special) to
	 *                          force a wildcard.
	 * @param int   $partition If >= 0, only restart workers on this partition.
	 *                         Use -1 to match any partition.
	 * @return int Number of restart-flag files written.
	 */
	public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int {
		$restarted = 0;
		$wildcard  = empty( $filter ) || isset( $filter['all'] );

		foreach ( $workers as $w ) {
			$type = $w['type'] ?? '';
			$p    = (int) ( $w['partition'] ?? 0 );
			if ( '' === $type ) {
				continue;
			}
			if ( ! $wildcard && empty( $filter[ $type ] ) ) {
				continue;
			}
			if ( $partition >= 0 && $p !== $partition ) {
				continue;
			}
			$lock_dir = "{$this->base_dir}/locks/{$type}.p{$p}.lock.d";
			if ( Lock::request_restart_at( $lock_dir ) ) {
				++$restarted;
			}
		}
		return $restarted;
	}

	/**
	 * Read live worker-cursor positions from memcache. Each worker publishes
	 * `{type}.p{partition}` to a key under `POSITION_KEY_PREFIX`; the value is
	 * an array `[ 'seg' => int, 'off' => int, 'ts' => int ]`.
	 *
	 * @param object $cache    Anything with a `get(string)` method (Cache_Interface
	 *                          or any duck-typed equivalent). Pass null to skip.
	 * @param string $type     Worker type.
	 * @param int    $partition Partition index.
	 * @return array{seg:int,off:int,ts?:int}|null Position or null if not in cache / unreachable.
	 */
	public function live_position( ?object $cache, string $type, int $partition ): ?array {
		if ( null === $cache || ! \method_exists( $cache, 'get' ) ) {
			return null;
		}
		try {
			$value = $cache->get( self::POSITION_KEY_PREFIX . "{$type}.p{$partition}" );
		} catch ( \Throwable $e ) {
			return null;
		}
		if ( ! \is_array( $value ) || ! isset( $value['seg'], $value['off'] ) ) {
			return null;
		}
		return [
			'seg' => (int) $value['seg'],
			'off' => (int) $value['off'],
			'ts'  => (int) ( $value['ts'] ?? 0 ),
		];
	}

	/**
	 * Read the latest checkpointed position from a worker's offsetlog directory.
	 * Used as the fallback when memcache is unreachable.
	 *
	 * Offsetlog layout: `{base}/offsets/{type}.p{partition}/p0/{segment_id}.log`
	 * (single-partition Partition writes JSONL `{seg, off, ts}` lines).
	 *
	 * @param string $type     Worker type.
	 * @param int    $partition Partition index.
	 * @return array{seg:int,off:int,ts?:int}|null
	 */
	public function saved_position( string $type, int $partition ): ?array {
		$offset_dir = "{$this->base_dir}/offsets/{$type}.p{$partition}/p0";
		if ( ! \is_dir( $offset_dir ) ) {
			return null;
		}
		$files = @\scandir( $offset_dir );
		if ( false === $files ) {
			return null;
		}
		$segments = [];
		foreach ( $files as $f ) {
			if ( \preg_match( '/^(\d+)\.log$/', $f, $m ) ) {
				$segments[] = (int) $m[1];
			}
		}
		if ( empty( $segments ) ) {
			return null;
		}
		\sort( $segments );
		$newest_id = (int) \end( $segments );
		$path      = "{$offset_dir}/{$newest_id}.log";
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$bytes = @\file_get_contents( $path );
		if ( false === $bytes || '' === $bytes ) {
			return null;
		}
		// Last non-empty line is the latest checkpoint.
		$lines = \array_filter( \explode( "\n", \rtrim( $bytes, "\n" ) ), static fn ( $l ) => '' !== $l );
		if ( empty( $lines ) ) {
			return null;
		}
		$last = \json_decode( (string) \end( $lines ), true );
		if ( ! \is_array( $last ) || ! isset( $last['seg'], $last['off'] ) ) {
			return null;
		}
		return [
			'seg' => (int) $last['seg'],
			'off' => (int) $last['off'],
			'ts'  => (int) ( $last['ts'] ?? 0 ),
		];
	}

	/**
	 * Sum bytes still ahead of a cursor across all segments of a partition. Used
	 * by `wp nodes status` to display "Behind" so operators can see consumer lag.
	 *
	 * @param string $partition_dir Absolute path to the partition directory.
	 * @param int    $cursor_seg    Cursor segment id.
	 * @param int    $cursor_offset Cursor offset within $cursor_seg.
	 * @return int Bytes remaining to be consumed (0 if caught up or partition missing).
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
	 * Format an uptime duration compactly for `wp nodes status`. Mirrors the
	 * event-logger plugin's `format_duration` so output is byte-for-byte
	 * compatible with operator scripts.
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
}
