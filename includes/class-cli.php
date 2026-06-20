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
	 * Representative live cursor for a worker (type, partition), from the
	 * TopicProbe index: the position of its primary input Consumer — the matching
	 * record (same worker_type, `.p{N}` suffix) with the shortest offset_dir, so a
	 * disambiguated reader (`firehose.job-router`) never shadows the base input
	 * (`firehose`). Null when the worker has no probe record yet.
	 *
	 * @param array<string,array<mixed>> $index     `read_probe_index()` output.
	 * @param string                     $type      Worker type.
	 * @param int                        $partition Partition index.
	 * @return array{seg:int,off:int,ts:int}|null
	 */
	public function live_position( array $index, string $type, int $partition ): ?array {
		$suffix = ".p{$partition}";
		$best   = null;
		foreach ( $index as $offset_dir => $record ) {
			if ( $type !== ( $record['worker_type'] ?? null ) || ! \str_ends_with( $offset_dir, $suffix ) ) {
				continue;
			}
			if ( null === $best || \strlen( $offset_dir ) < \strlen( $best ) ) {
				$best = $offset_dir;
			}
		}
		return null === $best ? null : self::normalize_probe_position( $index[ $best ] );
	}

	/**
	 * Coerce a probe record's cursor_seg/cursor_off/ts to a `{seg,off,ts}` int position.
	 *
	 * @param array<mixed> $record A `read_probe_index()` record.
	 * @return array{seg:int,off:int,ts:int}
	 */
	private static function normalize_probe_position( array $record ): array {
		$seg = $record['cursor_seg'] ?? 0;
		$off = $record['cursor_off'] ?? 0;
		$ts  = $record['ts'] ?? 0;
		return [
			'seg' => \is_numeric( $seg ) ? (int) $seg : 0,
			'off' => \is_numeric( $off ) ? (int) $off : 0,
			'ts'  => \is_numeric( $ts ) ? (int) $ts : 0,
		];
	}

	/**
	 * Index of every active Consumer's latest stats record from the shared
	 * topicprobe log, keyed by `offset_dir` (`{source_basename}.p{N}`) — the
	 * durable per-reader identity. This is the single live-position source the
	 * dashboard + `wp nodes ls/status` read (it replaced memcache + the offsetlog
	 * fallback); TopicProbe appends one record per Consumer every ~15s.
	 *
	 * @return array<string,array<mixed>> offset_dir → the latest probe record VALUE.
	 */
	public function read_probe_index(): array {
		return Partition_Node::read_tail_index_by(
			"{$this->base_dir}/logs/" . Worker_Base::TOPICPROBE_LOG_DIR,
			'offset_dir'
		);
	}

	/**
	 * One row per active Consumer, mapped from the topicprobe index
	 * (`read_probe_index()`). Rows whose record carries no worker_type are skipped
	 * (nothing to attribute them to). This is the canonical per-Consumer
	 * enumeration shared by the Worker Status dashboard (`Workers_CI_Node`) and
	 * `wp nodes status`.
	 *
	 * @return array<int,array{name:string,target:string,targets:array<int,array<string,mixed>>,worker_type:string,source_basename:string,source_log:string,partition:int,seg:int,off:int,behind:int,total:int,read_rate:float,write_rate:float,ts:float}>
	 */
	public function consumer_rows(): array {
		$rows = [];
		foreach ( $this->read_probe_index() as $offset_dir => $record ) {
			// offset_dir is `{source_basename}.p{N}` — the partition lives in the name.
			if ( ! \preg_match( '/^(.+)\.p(\d+)$/', $offset_dir, $m ) ) {
				continue;
			}
			$worker_type = self::scalar_string( $record['worker_type'] ?? '' );
			// Skip records that can't be attributed to a worker.
			if ( '' === $worker_type ) {
				continue;
			}
			/** @var array<int,array<string,mixed>> $targets Probe `targets`: a list of `{name,…}` objects. */
			$targets = \is_array( $record['targets'] ?? null ) ? $record['targets'] : [];
			$rows[]  = [
				'name'            => self::scalar_string( $record['consumer'] ?? '' ),
				'target'          => self::scalar_string( $record['target'] ?? '' ),
				'targets'         => $targets,
				'worker_type'     => $worker_type,
				'source_basename' => $m[1],
				'source_log'      => self::scalar_string( $record['source'] ?? '' ),
				'partition'       => (int) $m[2],
				'seg'             => self::scalar_int( $record['cursor_seg'] ?? 0 ),
				'off'             => self::scalar_int( $record['cursor_off'] ?? 0 ),
				// Backlog + partition-end as the probe measured them in ONE snapshot
				// (cursor vs end at the same instant) — readers use these instead of
				// re-statting the live partition against this stale cursor.
				'behind'          => self::scalar_int( $record['bytes_behind'] ?? 0 ),
				'total'           => self::scalar_int( $record['bytes_total'] ?? 0 ),
				// Byte rates the PROBE computed (Δ over its own ts). Displayed as-is —
				// never client-deltaed against a faster poll, which is what made the
				// read rate flicker (0 between 15s probe ticks) against a live write rate.
				'read_rate'       => self::scalar_float( $record['read_rate'] ?? 0 ),
				'write_rate'      => self::scalar_float( $record['write_rate'] ?? 0 ),
				'ts'              => self::scalar_float( $record['ts'] ?? 0 ),
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
}
