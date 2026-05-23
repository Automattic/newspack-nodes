<?php
/**
 * Workers_CI: command-dispatch for worker-lifecycle verbs.
 *
 * Verbs:
 *   list           — minimal worker enumeration (Cli::ls_workers() projection +
 *                    live cursor positions) for programmatic callers.
 *   dump_metadata  — full operator-grade 7-field envelope (`{workers[],
 *                    supervisor, logs[], num_partitions, num_segments,
 *                    segment_size, timestamp}`) the dashboard reads; heavyweight.
 *   cleanup_status — diagnostic of what Log_Cleaner sees vs the expected set.
 *   restart        — request restart for one or more worker types.
 *   heartbeat      — refresh an SSE slot for the current user.
 *
 * Cli + Cache are constructor-injected so tests can stub them.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Core;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\SSE_Slot_Pool;
use Newspack_Nodes\Log_Cleaner;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Topology_Registry;

\defined( 'ABSPATH' ) || exit;

class Workers_CI_Node extends Service_CI_Node {

	/**
	 * Build a Workers_CI bound to the supplied Cli + Cache.
	 *
	 * @param object      $cli   Duck-types Cli: `ls_workers()`, `live_position()`, `restart_workers()`.
	 * @param object|null $cache `\Memcached`-shaped (`get`) for live cursor reads; null forces
	 *                           offsetlog-only reads. The `heartbeat` verb refreshes SSE slots via
	 *                           `Sse_Slot_Pool::touch` against `Core::$memd`, independent of this arg.
	 */
	public function __construct( object $cli, ?object $cache = null ) {
		$this->commands( $this->verb_table( $cli, $cache ) );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Worker fleet control: list workers, dump operator metadata, audit/cleanup orphans, restart, and refresh SSE slot heartbeats.',
			'ctor'        => [],
			'verbs'       => [
				[ 'name' => 'list', 'description' => 'List workers with live positions.', 'args' => [] ],
				[ 'name' => 'dump_metadata', 'description' => 'Full operator-grade fleet/supervisor/log metadata.', 'args' => [] ],
				[ 'name' => 'cleanup_status', 'description' => 'Report orphaned worker artifacts vs the expected fleet.', 'args' => [] ],
				[
					'name'        => 'restart',
					'description' => 'Restart matching workers (and/or the supervisor).',
					'args'        => [
						[ 'name' => 'types', 'type' => 'json', 'required' => false ],
						[ 'name' => 'partition', 'type' => 'int', 'required' => false, 'default' => -1 ],
					],
				],
				[
					'name'        => 'heartbeat',
					'description' => "Refresh this session's SSE slot TTL.",
					'args'        => [
						[ 'name' => 'slot', 'type' => 'int', 'required' => true ],
						[ 'name' => 'ttl', 'type' => 'int', 'required' => false, 'default' => 10 ],
						[ 'name' => 'partition', 'type' => 'int', 'required' => false, 'default' => -1 ],
					],
				],
			],
		];
	}

	private function verb_table( object $cli, ?object $cache ): array {
		return [
			'list' => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ) use ( $cli, $cache ): array {
				$workers = $cli->ls_workers();
				foreach ( $workers as &$w ) {
					$w['position'] = $cli->live_position( $cache, $w['type'], $w['partition'] );
				}
				unset( $w );
				return $workers;
			},
			'dump_metadata' => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ) use ( $cache ): array {
				self::require_manage_options();
				return self::collect_dump_metadata( $cache );
			},
			'cleanup_status' => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
				// Diagnostic: surface what Log_Cleaner reads when deciding which
				// log dirs to delete, so operators can debug orphan-log sweeps.
				self::require_manage_options();
				$config        = RuntimeConfig::load_config();
				$base_dir      = (string) ( $config['base_directory'] ?? '/tmp/newspack-nodes' );
				$logs_dir      = $base_dir . '/logs';
				$dirty_flag    = \get_option( Log_Cleaner::LOGS_DIRTY_OPTION, null );
				$prior_fleet   = \get_option( Log_Cleaner::FLEET_DESCRIPTORS_OPTION, null );
				$on_disk       = [];
				foreach ( @\glob( $logs_dir . '/*.log', \GLOB_ONLYDIR ) ?: [] as $dir ) {
					if ( \preg_match( '#/([^/]+)\.log$#', $dir, $m ) ) {
						$on_disk[] = $m[1];
					}
				}
				\sort( $on_disk );
				// Use the same code path Log_Cleaner uses so the diagnostic
				// matches the cleanup sweep's actual expected set — substrate
				// computes the topology-derived basenames, then the filter
				// appends app runtime basenames.
				$expected = Log_Cleaner::expected_basenames( $base_dir );
				\sort( $expected );
				$orphans = \array_values( \array_diff( $on_disk, $expected ) );
				return [
					'logs_dirty_option'        => $dirty_flag,
					'fleet_descriptors_option' => $prior_fleet,
					'logs_dir'                 => $logs_dir,
					'on_disk_basenames'        => $on_disk,
					'expected_basenames'       => $expected,
					'orphans'                  => $orphans,
				];
			},
			'restart' => static function ( Command_Interpreter_Node $self, string $args, array $envelope, mixed $payload ) use ( $cli ): array {
				$decoded   = \is_array( $payload ) ? $payload : [];
				$types     = (array) ( $decoded['types']     ?? [] );
				$partition = (int)   ( $decoded['partition'] ?? -1 );
				$filter    = [];
				foreach ( $types as $t ) {
					$filter[ (string) $t ] = true;
				}
				$restarted = 0;
				// Supervisor lives at `supervisor.lock.d` (no partition
				// suffix); `restart_workers` only knows the `{type}.p{N}`
				// shape, so route the supervisor through its own path.
				if ( isset( $filter['supervisor'] ) && $cli->restart_supervisor() ) {
					++$restarted;
					unset( $filter['supervisor'] );
				}
				if ( ! empty( $filter ) || empty( $types ) ) {
					$restarted += $cli->restart_workers( $cli->ls_workers(), $filter, $partition );
				}
				return [ 'restarted' => $restarted ];
			},
			'heartbeat' => static function ( Command_Interpreter_Node $self, string $args ): array {
				if ( null === Core::$memd ) {
					throw new \RuntimeException( 'cache not configured' );
				}
				$parts = \preg_split( '/\s+/', \trim( $args ), -1, \PREG_SPLIT_NO_EMPTY );
				$slot  = isset( $parts[0] ) ? (int) $parts[0] : -1;
				if ( $slot < 0 ) {
					throw new \RuntimeException( 'slot required' );
				}
				$ttl       = isset( $parts[1] ) ? (int) $parts[1] : 10;
				$partition = isset( $parts[2] ) ? (int) $parts[2] : -1;
				$success   = SSE_Slot_Pool::touch( SSE_Slot_Pool::user_id(), SSE_Slot_Pool::ip_hash(), $slot, $ttl, $partition );
				return [ 'success' => $success, 'slot' => $slot ];
			},
		];
	}

	// -------------------------------------------------------------------------
	// dump_metadata helpers — the full operator-grade payload, ported wholesale
	// from the legacy WorkersController::get_workers + its private helpers.
	// Kept as static helpers on this class (rather than calling the legacy
	// controller directly) so the legacy file can be deleted without orphaning
	// the verb's behavior.
	// -------------------------------------------------------------------------

	/**
	 * Build the full 7-field operator-grade envelope.
	 *
	 * @param object|null $cache `\Memcached`-shaped (or null) for offsetlog-only cursor reads.
	 * @return array<string,mixed> Envelope ready for wp_json_encode.
	 */
	private static function collect_dump_metadata( ?object $cache ): array {
		$now            = \time();
		$config         = RuntimeConfig::load_config();
		$num_partitions = (int) ( $config['num_partitions'] ?? 1 );
		$num_segments   = (int) ( $config['num_segments']   ?? 8 );
		$segment_size   = (int) ( $config['segment_size']   ?? ( 16 * 1024 * 1024 ) );
		$base_dir       = (string) ( $config['base_directory'] ?? '/tmp/newspack-nodes' );
		$log_base       = $base_dir . '/logs';
		$locks_base     = $base_dir . '/locks';

		$descriptors = [];
		if ( \class_exists( '\\Newspack_Nodes\\Bootstrap' ) ) {
			try {
				$descriptors = Bootstrap::expand_workers();
			} catch ( \Throwable $e ) {
				$descriptors = [];
			}
		}

		// Each offsetlog entry carries `name`, `target`, `worker_type` so the
		// dashboard can render one row per (worker_type, consumer_name,
		// partition) without hardcoding a per-type inputs/outputs map.
		$offsetlog_rows = self::enumerate_offsetlog_rows( $base_dir );
		$rows_by_worker = [];
		foreach ( $offsetlog_rows as $row ) {
			$key = $row['worker_type'] . '|' . $row['partition'];
			if ( ! isset( $rows_by_worker[ $key ] ) ) {
				$rows_by_worker[ $key ] = [];
			}
			$rows_by_worker[ $key ][] = $row;
		}

		$workers = [];
		foreach ( $descriptors as $w ) {
			$type      = (string) ( $w['type'] ?? '' );
			$partition = (int) ( $w['partition'] ?? 0 );
			$stale_to  = (int) ( $w['stale_timeout'] ?? Lock_Node::STALE_TIMEOUT );
			if ( '' === $type ) {
				continue;
			}
			$lock_dir      = "{$locks_base}/{$type}.p{$partition}.lock.d";
			$consumer_rows = $rows_by_worker[ "{$type}|{$partition}" ] ?? [];

			if ( empty( $consumer_rows ) ) {
				// Worker hasn't checkpointed yet (fresh spawn) — emit a
				// single placeholder row so the dashboard still renders
				// the worker_type. No consumer metadata available.
				$placeholder = self::build_worker_status(
					$type,
					$partition,
					'',
					null,
					$log_base,
					$lock_dir,
					$now,
					$stale_to,
					null,
					$cache,
					$base_dir
				);
				$placeholder['inputs']         = [];
				$placeholder['outputs']        = [];
				$placeholder['inputs_status']  = [];
				$placeholder['outputs_status'] = [];
				$placeholder['target']         = '';
				$placeholder['source']         = null;
				$workers[]                     = $placeholder;
				continue;
			}

			foreach ( $consumer_rows as $row ) {
				$input_log = "{$row['source_basename']}.log";
				// Each Consumer can have multiple downstream processors
				// (Tee fan-out: firehose:tee → request-builder + job-router).
				// Emit one dashboard row per processor so the operator sees
				// the actual work units, not the Consumer plumbing.
				$targets = ! empty( $row['targets'] )
					? $row['targets']
					: [ [ 'name' => $row['target'] ] ];
				foreach ( $targets as $t ) {
					$handler = (string) ( $t['name'] ?? '' );
					$worker  = self::build_worker_status(
						$type,
						$partition,
						$input_log,
						$t['name'] ?? null,
						$log_base,
						$lock_dir,
						$now,
						$stale_to,
						$handler,
						$cache,
						$base_dir
					);
					$worker['target']         = $t['name'] ?? '';
					$worker['source']         = $row['name'];
					$worker['inputs']         = [ $input_log ];
					$worker['outputs']        = [];
					$worker['inputs_status']  = [
						self::build_log_status_entry(
							$input_log,
							$partition,
							(int) $worker['cursor_seg'],
							(int) $worker['cursor_offset'],
							$log_base
						),
					];
					$worker['outputs_status'] = [];
					$workers[]                = $worker;
				}
			}
		}

		// Supervisor status. Singleton — there is exactly one supervisor per
		// install, at `supervisor.lock.d/` (no partition suffix). The
		// dashboard renders its own card for this; it isn't grouped with
		// partitioned workers.
		$supervisor = self::build_supervisor_status( "{$locks_base}/supervisor.lock.d", $now );

		// Per-log per-partition slot list. Lets the dashboard show (a)
		// configured-but-empty slots when the producer hasn't written yet
		// and (b) stale slots left over when num_partitions shrinks (orphan
		// data the producer no longer touches). Cursor data is overlaid by
		// the frontend from `workers[]`.
		//
		// Build a `{basename => int}` overrides map across every active
		// topology so each log entry reflects the literal `segment_size`
		// declared in TSL (e.g. `completed.log` / `gyroscope.log` hardcoded
		// to 1 MiB) instead of the global config default. Token-substituted
		// (`<config:segment_size>`) Partition lines contribute nothing here;
		// `enumerate_logs` falls back to `$segment_size` for those.
		$segment_size_overrides = self::collect_segment_size_overrides();
		$logs                   = self::enumerate_logs( $log_base, $num_partitions, $segment_size, $segment_size_overrides );

		return [
			'workers'        => $workers,
			'supervisor'     => $supervisor,
			'logs'           => $logs,
			'num_partitions' => $num_partitions,
			'num_segments'   => $num_segments,
			'segment_size'   => $segment_size,
			'timestamp'      => $now,
		];
	}

	/**
	 * Build the per-worker rich descriptor, adding `live`/`stale`/`heartbeat_at`
	 * from the heartbeat mtime so the dashboard renders status badges in one round-trip.
	 *
	 * @param object|null $cache    `\Memcached`-shaped instance for live cursor lookups (or null).
	 * @param string      $base_dir Substrate base directory.
	 */
	private static function build_worker_status(
		string $type,
		int $partition,
		string $input_log,
		?string $output_log,
		string $log_base,
		string $lock_dir,
		int $now,
		int $stale_timeout,
		?string $handler_name,
		?object $cache,
		string $base_dir
	): array {
		// Workers without a local tail (e.g. SSE aggregator pulls) have no Partition;
		// skip the segment lookup and report zeroed stats.
		if ( '' === $input_log ) {
			$segments      = [];
			$total_size    = 0;
			$cursor_seg    = 0;
			$cursor_offset = 0;
			$behind        = 0;
		} else {
			$partition_obj = new Partition_Node( "{$log_base}/{$input_log}", $partition );
			$segments      = $partition_obj->get_segments();
			$total_size    = (int) \array_sum( \array_column( $segments, 'size' ) );

			// Cursor: live memcache position, falling back to the on-disk offsetlog.
			$cursor        = self::get_live_position( $type, $partition, $input_log, $cache, $base_dir );
			$cursor_seg    = (int) ( $cursor['seg'] ?? 0 );
			$cursor_offset = (int) ( $cursor['off'] ?? 0 );

			// Bytes-behind: sum remaining bytes in segments at/after cursor_seg.
			$behind        = 0;
			$found_current = false;
			foreach ( $segments as $seg ) {
				$sid = (int) $seg['id'];
				if ( $sid === $cursor_seg ) {
					$found_current = true;
					$remaining     = (int) $seg['size'] - $cursor_offset;
					if ( $remaining > 0 ) {
						$behind += $remaining;
					}
				} elseif ( $found_current || $sid > $cursor_seg ) {
					$behind += (int) $seg['size'];
				}
			}
		}

		// Status: heartbeat freshness inside the lock dir.
		$status        = 'dead';
		$heartbeat_age = null;
		$heartbeat_at  = 0;
		$hb_file       = $lock_dir . '/heartbeat';
		if ( \file_exists( $hb_file ) ) {
			$mtime = @\filemtime( $hb_file );
			if ( false !== $mtime ) {
				$heartbeat_at  = (int) $mtime;
				$heartbeat_age = $now - (int) $mtime;
				if ( $heartbeat_age < $stale_timeout ) {
					$status = 'running';
				}
			}
		}
		// `live`/`stale`: Cli::ls_workers()-style heartbeat projections surfaced here so the
		// dashboard skips a second `list` round-trip. stale = heartbeat older than stale_timeout.
		$live  = ( 'running' === $status );
		$stale = ( ! $live && null !== $heartbeat_age );

		return [
			'type'            => $type,
			'partition'       => $partition,
			'input_log'       => $input_log,
			'output_log'      => $output_log,
			'status'          => $status,
			'started_at'      => Lock_Node::get_started_time( $lock_dir ),
			'heartbeat_age'   => $heartbeat_age,
			'heartbeat_at'    => $heartbeat_at,
			'live'            => $live,
			'stale'           => $stale,
			'restart_pending' => Lock_Node::is_restart_pending( $lock_dir ),
			'segments'        => $segments,
			'total_size'      => $total_size,
			'cursor_seg'      => $cursor_seg,
			'cursor_offset'   => $cursor_offset,
			'behind'          => $behind,
			'handler'         => $handler_name,
		];
	}

	/**
	 * Build the supervisor descriptor (status, heartbeat age, started_at,
	 * restart_pending). Singleton, so no `partition` field.
	 */
	private static function build_supervisor_status( string $lock_dir, int $now ): array {
		$status        = 'dead';
		$heartbeat_age = null;
		$hb_file       = $lock_dir . '/heartbeat';
		if ( \file_exists( $hb_file ) ) {
			$mtime = @\filemtime( $hb_file );
			if ( false !== $mtime ) {
				$heartbeat_age = $now - (int) $mtime;
				if ( $heartbeat_age < Lock_Node::STALE_TIMEOUT ) {
					$status = 'running';
				}
			}
		}

		return [
			'type'            => 'supervisor',
			'status'          => $status,
			'started_at'      => Lock_Node::get_started_time( $lock_dir ),
			'heartbeat_age'   => $heartbeat_age,
			'restart_pending' => Lock_Node::is_restart_pending( $lock_dir ),
		];
	}

	/**
	 * Union the per-Partition `segment_size` overrides across every active
	 * topology (last-write-wins on basename collision).
	 *
	 * @return array<string,int> `{basename => int}` (basename without `.log`).
	 */
	private static function collect_segment_size_overrides(): array {
		$topologies = [];
		if ( \class_exists( '\\Newspack_Nodes\\Bootstrap' ) ) {
			try {
				$topologies = Bootstrap::get_topologies();
			} catch ( \Throwable $e ) {
				$topologies = [];
			}
		}
		$out = [];
		foreach ( $topologies as $name => $_cfg ) {
			$overrides = Topology_Registry::segment_size_overrides_for( (string) $name );
			foreach ( $overrides as $basename => $size ) {
				$out[ $basename ] = $size;
			}
		}
		return $out;
	}

	/**
	 * Walk `{logs_dir}/*.log/` and return one entry per log, covering the union
	 * of configured and on-disk partition slots. Cursor fields are overlaid by
	 * the frontend; per-log `segment_size` honors any TSL literal override.
	 *
	 * @param array<string,int> $segment_size_overrides `{basename => int}` map.
	 * @return array<int,array{name:string,partitions:array,segment_size:int}>
	 */
	private static function enumerate_logs(
		string $log_base,
		int $num_partitions,
		int $default_segment_size,
		array $segment_size_overrides
	): array {
		if ( ! \is_dir( $log_base ) ) {
			return [];
		}
		$entries = @\scandir( $log_base );
		if ( false === $entries ) {
			return [];
		}
		$logs = [];
		foreach ( $entries as $entry ) {
			if ( '.' === $entry || '..' === $entry ) {
				continue;
			}
			if ( ! \preg_match( '/^(.+)\.log$/', $entry, $m ) ) {
				continue;
			}
			$log_dir      = "{$log_base}/{$entry}";
			$part_entries = @\scandir( $log_dir );
			if ( false === $part_entries ) {
				continue;
			}
			$on_disk = [];
			foreach ( $part_entries as $pe ) {
				if ( \preg_match( '/^p(\d+)$/', $pe, $pm ) ) {
					$on_disk[ (int) $pm[1] ] = true;
				}
			}
			$max_disk   = empty( $on_disk ) ? -1 : \max( \array_keys( $on_disk ) );
			$slot_count = \max( $num_partitions, $max_disk + 1 );
			if ( $slot_count < 1 ) {
				continue;
			}
			$partitions = [];
			for ( $p = 0; $p < $slot_count; $p++ ) {
				if ( isset( $on_disk[ $p ] ) ) {
					$status       = self::build_log_status_entry( $entry, $p, null, null, $log_base );
					$partitions[] = [
						'partition'  => $p,
						'segments'   => $status['segments'] ?? [],
						'total_size' => $status['total_size'] ?? 0,
					];
				} else {
					// Padded slot: configured partition with no on-disk dir yet — emit empty inline.
					$partitions[] = [
						'partition'  => $p,
						'segments'   => [],
						'total_size' => 0,
					];
				}
			}
			$basename = $m[1];
			$logs[]   = [
				'name'         => $entry,
				'partitions'   => $partitions,
				'segment_size' => $segment_size_overrides[ $basename ] ?? $default_segment_size,
			];
		}
		return $logs;
	}

	/**
	 * Scan a log's segment directory and return the per-log status block for
	 * `inputs_status` / `outputs_status`. Cursor fields included only when both
	 * `$cursor_seg` and `$cursor_offset` are non-null (else the UI treats it as output-only).
	 */
	private static function build_log_status_entry(
		string $log_name,
		int $partition,
		?int $cursor_seg,
		?int $cursor_offset,
		string $log_base
	): array {
		$segment_dir = "{$log_base}/{$log_name}/p{$partition}";
		$segments    = [];
		$total_size  = 0;
		if ( \is_dir( $segment_dir ) ) {
			$files = @\scandir( $segment_dir );
			if ( \is_array( $files ) ) {
				foreach ( $files as $file ) {
					if ( \preg_match( '/^(\d+)\.log$/', $file, $m ) ) {
						$path = "{$segment_dir}/{$file}";
						if ( \is_link( $path ) ) {
							continue;
						}
						$size       = @\filesize( $path );
						$mtime      = @\filemtime( $path );
						$segments[] = [
							'id'    => (int) $m[1],
							'size'  => false !== $size ? (int) $size : 0,
							'mtime' => false !== $mtime ? (int) $mtime : 0,
						];
						$total_size += false !== $size ? (int) $size : 0;
					}
				}
				\usort( $segments, static fn ( $a, $b ) => $a['id'] <=> $b['id'] );
			}
		}
		$entry = [
			'name'       => $log_name,
			'partition'  => $partition,
			'segments'   => $segments,
			'total_size' => $total_size,
		];
		if ( null !== $cursor_seg && null !== $cursor_offset ) {
			$entry['cursor_seg']    = $cursor_seg;
			$entry['cursor_offset'] = $cursor_offset;
		}
		return $entry;
	}

	/**
	 * Live cursor lookup: prefer memcache (`np:pos:{host}:{source_path}:p{N}`),
	 * fall back to the Consumer's offsetlog.
	 *
	 * @return array{seg:int, off:int}|null
	 */
	private static function get_live_position( string $type, int $partition, string $input_log, ?object $cache, string $base_dir ): ?array {
		$source_path = "{$base_dir}/logs/{$input_log}";
		$host        = \gethostname() ?: 'unknown';
		$cache_key   = "np:pos:{$host}:{$source_path}:p{$partition}";

		// Null cache skips to the offsetlog; a raw \Memcached has get(), no is_available().
		if ( null !== $cache && \method_exists( $cache, 'get' ) ) {
			$val = $cache->get( $cache_key );
			if ( \is_array( $val ) && isset( $val['seg'], $val['off'] ) ) {
				return [ 'seg' => (int) $val['seg'], 'off' => (int) $val['off'] ];
			}
		}
		return self::read_offsetlog_position( $input_log, $partition, $base_dir );
	}

	/**
	 * Scan `{base}/offsets/` and return one entry per active Consumer. Each
	 * Consumer's latest checkpoint carries name/target/worker_type, enough to
	 * render a per-Consumer row without a hardcoded map.
	 *
	 * @return array<int,array{name:string,target:string,targets:array<int,array<string,mixed>>,worker_type:string,source_basename:string,partition:int,seg:int,off:int,ts:float}>
	 */
	private static function enumerate_offsetlog_rows( string $base_dir ): array {
		$offsets_dir = "{$base_dir}/offsets";
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
			// Expect `{source}.p{N}` directory naming.
			if ( ! \preg_match( '/^(.+)\.p(\d+)$/', $entry, $m ) ) {
				continue;
			}
			$source_basename = $m[1];
			$partition       = (int) $m[2];
			$row             = self::read_offsetlog_latest_entry( "{$offsets_dir}/{$entry}" );
			if ( null === $row ) {
				continue;
			}
			// Skip entries pre-dating the metadata addition (no worker_type to attribute the row).
			if ( '' === ( $row['worker_type'] ?? '' ) ) {
				continue;
			}
			$rows[] = [
				'name'            => (string) ( $row['name']   ?? '' ),
				'target'          => (string) ( $row['target'] ?? '' ),
				'targets'         => \is_array( $row['targets'] ?? null ) ? $row['targets'] : [],
				'worker_type'     => (string) $row['worker_type'],
				'source_basename' => $source_basename,
				'partition'       => $partition,
				'seg'             => (int) ( $row['seg'] ?? 0 ),
				'off'             => (int) ( $row['off'] ?? 0 ),
				'ts'              => (float) ( $row['ts']  ?? 0 ),
			];
		}
		return $rows;
	}

	/**
	 * Read the latest committed offsetlog entry's VALUE array (null if
	 * empty/unreadable). The offsetlog is itself a single-partition Partition (p0);
	 * the outer `{source}.p{N}/` dir name encodes the spoke partition.
	 *
	 * @return array<string,mixed>|null
	 */
	private static function read_offsetlog_latest_entry( string $offsetlog_dir ): ?array {
		try {
			$offsetlog = new Partition_Node( $offsetlog_dir, 0 );
			$segments  = $offsetlog->get_segments( true );
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
			$msg   = Message::unpacked( (string) \end( $lines ) );
			$entry = $msg[ Message::VALUE ] ?? null;
			return \is_array( $entry ) ? $entry : null;
		} catch ( \Throwable $e ) {
			return null;
		}
	}

	/**
	 * Read the latest committed cursor from the on-disk offsetlog.
	 *
	 * @return array{seg:int, off:int}|null
	 */
	private static function read_offsetlog_position( string $input_log, int $partition, string $base_dir ): ?array {
		$basename = \preg_replace( '/\.log$/', '', $input_log );
		$entry    = self::read_offsetlog_latest_entry( "{$base_dir}/offsets/{$basename}.p{$partition}" );
		if ( null === $entry || ! isset( $entry['seg'], $entry['off'] ) ) {
			return null;
		}
		return [ 'seg' => (int) $entry['seg'], 'off' => (int) $entry['off'] ];
	}
}
