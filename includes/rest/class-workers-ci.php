<?php
/**
 * Workers_CI: command-dispatch for worker-lifecycle verbs.
 *
 * Replaces legacy class-workers-controller.php + the heartbeat method on
 * class-firehose-controller.php with a CommandInterpreter that mounts on the
 * `newspack_nodes/request_graph_ready` hook alongside the other substrate
 * service CIs (Classes_CI, Layouts_CI, Topologies_CI).
 *
 * Verbs:
 *   list          — minimal worker enumeration (Cli::ls_workers() projection
 *                    with live cursor positions). Used by topology + CLI
 *                    callers that just need `[{type, partition, heartbeat_at,
 *                    stale, position}]`.
 *   dump_metadata — full operator-grade payload (the legacy WorkersController::
 *                    get_workers() shape). Returns the 7-field envelope
 *                    `{workers[], standalone[], logs[], num_partitions,
 *                    num_segments, segment_size, timestamp}` with per-worker
 *                    rich descriptors. Heavyweight (disk walks, offsetlog
 *                    reads, segment metadata, behind-byte calculations);
 *                    the dashboard reads this, not list.
 *   restart       — request restart for one or more worker types.
 *   heartbeat     — refresh an SSE slot for the current user.
 *
 * Why split list vs dump_metadata? list is the tight projection programmatic
 * callers want (~one row per partition, minimal data). dump_metadata is the
 * dashboard's introspection payload — segment metadata, cursor positions,
 * lag in bytes, per-input-log status, etc. Mirrors topology-console's
 * `dump_state` vs `list` pattern: same data tree, different read shapes.
 *
 * Dependencies are injected via the constructor so tests can stub Cli
 * and Cache without touching the substrate's request-scope graph; this
 * mirrors the dependency-injection pattern other M2 CIs adopted.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Lock;
use Newspack_Nodes\Log_Cleaner;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Service_CI;
use Newspack_Nodes\Topology_Registry;

\defined( 'ABSPATH' ) || exit;

class Workers_CI extends Service_CI {

	/**
	 * Build a Workers_CI bound to the supplied Cli + Cache.
	 *
	 * @param object      $cli   Anything exposing `ls_workers()`, `live_position(?$cache, $type, $partition)`,
	 *                            and `restart_workers(array $workers, array $filter, int $partition)`.
	 *                            Production passes \Newspack_Nodes\Cli; tests pass anon classes that
	 *                            duck-type the same surface.
	 * @param object|null $cache Anything exposing `touch_sse_slot($user_id, $ip_hash, $slot, $ttl, $partition)`
	 *                            (for the heartbeat verb) plus `is_available()` + `get(string)` (for the
	 *                            dump_metadata verb's live-position lookup). Production passes the
	 *                            application's Cache_Interface implementation (e.g. Memcached_Cache);
	 *                            tests pass a FakeMemcached or anon stub. Null disables the heartbeat
	 *                            verb and forces dump_metadata to fall back to on-disk offsetlog reads
	 *                            exclusively.
	 */
	public function __construct( object $cli, ?object $cache = null ) {
		// Node + CommandInterpreter have no explicit __construct, so the
		// inherited no-op is implicit. Mirrors RequestBuilder /
		// FlameBuilder, which extend Node and also skip the parent call.
		$this->commands( $this->verb_table( $cli, $cache ) );
	}

	private function verb_table( object $cli, ?object $cache ): array {
		return [
			'list' => static function ( CommandInterpreter $self, string $args, array $envelope = [] ) use ( $cli, $cache ): string {
				$workers = $cli->ls_workers();
				foreach ( $workers as &$w ) {
					$w['position'] = $cli->live_position( $cache, $w['type'], $w['partition'] );
				}
				unset( $w );
				return (string) \wp_json_encode( $workers );
			},
			'dump_metadata' => static function ( CommandInterpreter $self, string $args, array $envelope = [] ) use ( $cache ): string {
				self::require_manage_options();
				return (string) \wp_json_encode( self::collect_dump_metadata( $cache ) );
			},
			'cleanup_status' => static function ( CommandInterpreter $self, string $args, array $envelope = [] ): string {
				// Diagnostic: surface every input Log_Cleaner reads when it
				// decides whether to delete on-disk log dirs. Lets operators
				// answer "the dashboard shows orphan logs — why isn't the
				// sweep cleaning them?" without shell access.
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
				$expected = \apply_filters( 'newspack_nodes/expected_log_basenames', [] );
				$expected = \is_array( $expected ) ? \array_values( \array_unique( $expected ) ) : [];
				\sort( $expected );
				$orphans = \array_values( \array_diff( $on_disk, $expected ) );
				return (string) \wp_json_encode( [
					'logs_dirty_option'        => $dirty_flag,
					'fleet_descriptors_option' => $prior_fleet,
					'logs_dir'                 => $logs_dir,
					'on_disk_basenames'        => $on_disk,
					'expected_basenames'       => $expected,
					'orphans'                  => $orphans,
				] );
			},
			'restart' => static function ( CommandInterpreter $self, string $args, array $envelope, mixed $payload ) use ( $cli ): string {
				$decoded   = \is_array( $payload ) ? $payload : [];
				$types     = (array) ( $decoded['types']     ?? [] );
				$partition = (int)   ( $decoded['partition'] ?? -1 );
				$filter    = [];
				foreach ( $types as $t ) {
					$filter[ (string) $t ] = true;
				}
				$workers   = $cli->ls_workers();
				$restarted = $cli->restart_workers( $workers, $filter, $partition );
				return (string) \wp_json_encode( [ 'restarted' => $restarted ] );
			},
			'heartbeat' => static function ( CommandInterpreter $self, string $args, array $envelope, mixed $payload ) use ( $cache ): string {
				if ( null === $cache ) {
					throw new \RuntimeException( 'cache not configured' );
				}
				$decoded = \is_array( $payload ) ? $payload : [];
				$slot    = (int) ( $decoded['slot'] ?? -1 );
				if ( $slot < 0 ) {
					throw new \RuntimeException( 'slot required' );
				}
				$ttl       = (int) ( $decoded['ttl']       ?? 10 );
				$partition = (int) ( $decoded['partition'] ?? -1 );
				$user_id   = \function_exists( 'get_current_user_id' ) ? (int) \get_current_user_id() : 0;
				// phpcs:ignore WordPressVIPMinimum.Variables.RestrictedVariables.cache_constraints___SERVER__REMOTE_ADDR__, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized, WordPressVIPMinimum.Variables.ServerVariables.UserControlledHeaders
				$ip_hash   = \substr( \md5( (string) ( $_SERVER['REMOTE_ADDR'] ?? '' ) ), 0, 8 );
				$success   = (bool) $cache->touch_sse_slot( $user_id, $ip_hash, $slot, $ttl, $partition );
				return (string) \wp_json_encode( [ 'success' => $success, 'slot' => $slot ] );
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
	 * Build the full 7-field operator-grade envelope. Mirror of
	 * WorkersController::get_workers() — same field shapes, same disk-walk
	 * choreography, same memcache-first fallback-to-offsetlog cursor lookup.
	 *
	 * @param object|null $cache Cache_Interface-shaped instance, or null to
	 *                            skip memcache cursor lookups (offsetlog only).
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
			$stale_to  = (int) ( $w['stale_timeout'] ?? Lock::STALE_TIMEOUT );
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

		// Standalone workers (supervisor + plugin-registered partitioned /
		// non-partitioned). The filter is substrate-namespaced; applications
		// that need additional standalone fleets surfaced register against
		// `newspack_nodes/standalone_workers`.
		$standalone   = [];
		$standalone[] = self::build_standalone_status(
			'supervisor',
			null,
			"{$locks_base}/supervisor.lock.d",
			$now,
			Lock::STALE_TIMEOUT
		);
		$standalone_workers = [];
		if ( \function_exists( 'apply_filters' ) ) {
			$standalone_workers = (array) \apply_filters( 'newspack_nodes/standalone_workers', [] );
		}
		foreach ( $standalone_workers as $name => $cfg ) {
			$partitioned = ! empty( $cfg['partitions'] );
			if ( $partitioned ) {
				for ( $p = 0; $p < $num_partitions; $p++ ) {
					$standalone[] = self::build_standalone_status( (string) $name, $p, "{$locks_base}/{$name}.p{$p}.lock.d", $now );
				}
			} else {
				$standalone[] = self::build_standalone_status( (string) $name, null, "{$locks_base}/{$name}.lock.d", $now );
			}
		}

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
			'standalone'     => $standalone,
			'logs'           => $logs,
			'num_partitions' => $num_partitions,
			'num_segments'   => $num_segments,
			'segment_size'   => $segment_size,
			'timestamp'      => $now,
		];
	}

	/**
	 * Build the per-worker rich descriptor. Mirror of
	 * WorkersController::build_worker_status with added `live`/`stale`/
	 * `heartbeat_at` fields surfaced from the heartbeat file's mtime so
	 * the dashboard can render the Cli-style status badges without a
	 * separate `list` round-trip.
	 *
	 * @param object|null $cache    Cache_Interface-shaped instance for live cursor lookups (or null).
	 * @param string      $base_dir Substrate base directory (passed in so live-position
	 *                               key matches the legacy controller's key shape exactly).
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
		// Workers without a local tail (e.g. aggregator pulls remote feeds
		// via SSE) have no Partition to scan; skip the segment lookup and
		// report zeroed stats so the dashboard renders a clean row.
		if ( '' === $input_log ) {
			$segments      = [];
			$total_size    = 0;
			$cursor_seg    = 0;
			$cursor_offset = 0;
			$behind        = 0;
		} else {
			$partition_obj = new Partition( "{$log_base}/{$input_log}", $partition );
			$segments      = $partition_obj->get_segments();
			$total_size    = (int) \array_sum( \array_column( $segments, 'size' ) );

			// Cursor: live position from memcache; falls back to the on-disk
			// offsetlog when memcache is unreachable or absent.
			$cursor        = self::get_live_position( $type, $partition, $input_log, $cache, $base_dir );
			$cursor_seg    = (int) ( $cursor['seg'] ?? 0 );
			$cursor_offset = (int) ( $cursor['off'] ?? 0 );

			// Bytes-behind: walk segments at/after cursor_seg, summing
			// remaining bytes.
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
		// `live` and `stale` are the Cli::ls_workers()-style projections of
		// the same heartbeat state — surfaced on the descriptor so the
		// dashboard doesn't need a second `list` round-trip to render the
		// status badges. `stale=true` when the heartbeat exists but is
		// older than stale_timeout (= the Cli's "stale" classification).
		$live  = ( 'running' === $status );
		$stale = ( ! $live && null !== $heartbeat_age );

		return [
			'type'            => $type,
			'partition'       => $partition,
			'input_log'       => $input_log,
			'output_log'      => $output_log,
			'status'          => $status,
			'started_at'      => Lock::get_started_time( $lock_dir ),
			'heartbeat_age'   => $heartbeat_age,
			'heartbeat_at'    => $heartbeat_at,
			'live'            => $live,
			'stale'           => $stale,
			'restart_pending' => Lock::is_restart_pending( $lock_dir ),
			'segments'        => $segments,
			'total_size'      => $total_size,
			'cursor_seg'      => $cursor_seg,
			'cursor_offset'   => $cursor_offset,
			'behind'          => $behind,
			'handler'         => $handler_name,
		];
	}

	/**
	 * Build the standalone-worker descriptor (supervisor + plugin-registered).
	 * Mirror of WorkersController::build_standalone_status.
	 */
	private static function build_standalone_status( string $name, ?int $partition, string $lock_dir, int $now, int $stale_timeout = 60 ): array {
		$status        = 'dead';
		$heartbeat_age = null;
		$hb_file       = $lock_dir . '/heartbeat';
		if ( \file_exists( $hb_file ) ) {
			$mtime = @\filemtime( $hb_file );
			if ( false !== $mtime ) {
				$heartbeat_age = $now - (int) $mtime;
				if ( $heartbeat_age < $stale_timeout ) {
					$status = 'running';
				}
			}
		}

		return [
			'type'            => $name,
			'partition'       => $partition,
			'status'          => $status,
			'started_at'      => Lock::get_started_time( $lock_dir ),
			'heartbeat_age'   => $heartbeat_age,
			'restart_pending' => Lock::is_restart_pending( $lock_dir ),
		];
	}

	/**
	 * Union the per-Partition `segment_size` overrides declared across every
	 * active topology. Same basename in two topologies → last-write-wins;
	 * topologies in practice don't collide on per-log overrides, but the
	 * fallback is harmless because TSL parsing is deterministic.
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
	 * Walk `{logs_dir}/*.log/` and return one entry per log. Each entry's
	 * `partitions[]` covers slots `0..max( num_partitions, max-on-disk + 1 )`,
	 * which is the union of "configured" (so freshly-bumped partitions show
	 * up before they're written) and "on disk" (so orphan partitions left
	 * over when num_partitions shrinks remain visible). Cursor fields are
	 * omitted here; the frontend overlays them from `workers[]`. Per-log
	 * `segment_size` reflects any literal-int override declared in the
	 * topology's Partition line; otherwise the global default applies.
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
					// Padded slot — configured partition with no on-disk
					// dir yet. Skip the scandir + filesize loop and emit
					// an empty entry inline.
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
	 * Scan a log's segment directory and return the per-log status block
	 * used by `inputs_status` / `outputs_status`. Cursor fields are
	 * included only when both `$cursor_seg` and `$cursor_offset` are
	 * non-null — the React `LogSection` treats absent cursor data as
	 * "output-only" (all segments rendered green).
	 *
	 * Mirror of WorkersController::build_log_status_entry.
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
	 * Live cursor lookup. Prefer memcache (workers publish positions every
	 * ~10s under `np:pos:{host}:{source_path}:p{N}`); fall back to reading
	 * the Consumer's offsetlog directly.
	 *
	 * Mirror of WorkersController::get_live_position, kept on this class
	 * so deletion of the legacy controller doesn't orphan the lookup.
	 *
	 * @return array{seg:int, off:int}|null
	 */
	private static function get_live_position( string $type, int $partition, string $input_log, ?object $cache, string $base_dir ): ?array {
		$source_path = "{$base_dir}/logs/{$input_log}";
		$host        = \gethostname() ?: 'unknown';
		$cache_key   = "np:pos:{$host}:{$source_path}:p{$partition}";

		// `is_available` + `get` are the Cache_Interface contract; null
		// `$cache` (e.g. test that doesn't wire one) skips straight to
		// the offsetlog.
		if ( null !== $cache && \method_exists( $cache, 'is_available' ) && $cache->is_available() ) {
			$val = $cache->get( $cache_key );
			if ( \is_array( $val ) && isset( $val['seg'], $val['off'] ) ) {
				return [ 'seg' => (int) $val['seg'], 'off' => (int) $val['off'] ];
			}
		}
		return self::read_offsetlog_position( $input_log, $partition, $base_dir );
	}

	/**
	 * Scan `{base}/offsets/` and return one entry per active Consumer.
	 *
	 * Each Consumer publishes its name + target + worker_type into its
	 * offsetlog on every checkpoint (see Consumer::checkpoint), so the
	 * latest entry of each `{source}.p{N}/` directory tells the dashboard
	 * everything it needs to render a per-Consumer row without hardcoding
	 * a per-worker-type inputs/outputs map.
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
			// Skip entries that pre-date the metadata addition (no
			// worker_type means we can't attribute the row to a worker).
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
	 * Read the latest committed offsetlog entry and return its VALUE array
	 * (or null if empty/unreadable). Each Consumer's offsetlog is itself a
	 * single-partition Partition (Consumer constructs it as `new Partition(
	 * $dir, 0 )`). The OUTER `{source}.p{N}/` dir name encodes the spoke
	 * partition; the inner Partition is always p0.
	 *
	 * @return array<string,mixed>|null
	 */
	private static function read_offsetlog_latest_entry( string $offsetlog_dir ): ?array {
		try {
			$offsetlog = new Partition( $offsetlog_dir, 0 );
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
