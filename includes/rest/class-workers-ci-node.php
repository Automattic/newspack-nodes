<?php
/**
 * Workers_CI: command-dispatch for worker-lifecycle verbs.
 *
 * Verbs:
 *   list           — minimal worker enumeration (Cli::ls_workers() projection +
 *                    live cursor positions) for programmatic callers.
 *   dump_graph     — full operator-grade envelope (`{workers[], supervisor,
 *                    logs[], num_partitions, num_segments, segment_size,
 *                    timestamp}`) plus a `graph` map of active-topology-name =>
 *                    `{nodes, edges}`; the dashboard reads it; heavyweight.
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
use Newspack_Nodes\CLI;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\SSE_Slot_Pool;
use Newspack_Nodes\Log_Cleaner;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_Base;

\defined( 'ABSPATH' ) || exit;

class Workers_CI_Node extends Service_CI_Node {

	/**
	 * Cli helper the `list`/`dump_graph`/`restart` handlers reach via
	 * `$self->cli`. Public so the bootstrap (or test) assigns it AFTER
	 * `new Workers_CI_Node()` — the Tachikoma uniform-construction pattern
	 * (`make_node` calls a no-arg ctor; programmatic deps come in via public
	 * properties, not constructor args, since `arguments()` only handles
	 * scalar config). node_schema() is static and can't `use` an instance
	 * field, so handlers read the assigned value off `$self` at dispatch
	 * time (legal: they're defined inside this class and so may touch its
	 * props on any instance).
	 *
	 * Nullable + default null so a freshly-constructed interpreter is in a known,
	 * type-safe state until the bootstrap wires up the dep; verb handlers
	 * that dereference `$self->cli` will fail loud if the bootstrap forgot
	 * to assign it, rather than constructing into uninitialised-property UB.
	 *
	 * Native type stays `object` (a duck-typed injection seam tests fill with a
	 * fake); the `@var` names the production CLI shape so static analysis can
	 * see the worker-control methods the handlers call.
	 *
	 * @var \Newspack_Nodes\CLI|null
	 */
	public ?object $cli = null;

	/**
	 * The injected Cli, materialized non-null. Fails loud if the bootstrap
	 * forgot to assign `$cli` before a worker-control verb dispatches.
	 *
	 * @return \Newspack_Nodes\CLI
	 */
	public function cli(): object {
		if ( null === $this->cli ) {
			throw new \RuntimeException( 'Workers_CI_Node requires an injected cli; bootstrap must assign $cli first' );
		}
		return $this->cli;
	}

	// -------------------------------------------------------------------------
	// dump_graph helpers — the full operator-grade payload, ported wholesale
	// from the legacy WorkersController::get_workers + its private helpers.
	// Kept as static helpers on this class (rather than calling the legacy
	// controller directly) so the legacy file can be deleted without orphaning
	// the verb's behavior.
	// -------------------------------------------------------------------------

	/**
	 * Build the full 7-field operator-grade envelope.
	 *
	 * @return array<string,mixed> Envelope ready for wp_json_encode.
	 */
	private static function collect_dump_metadata(): array {
		$now            = \time();
		$config         = RuntimeConfig::load_config();
		$num_partitions = self::to_int( $config['num_partitions'] ?? 1 );
		$num_segments   = self::to_int( $config['num_segments']   ?? 8 );
		$segment_size   = self::to_int( $config['segment_size']   ?? ( 16 * 1024 * 1024 ) );
		$base_dir       = RuntimeConfig::get_base_directory();
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
			$type      = $w['type'];
			$partition = $w['partition'];
			$stale_to  = self::to_int( $w['stale_timeout'] ?? Lock_Node::STALE_TIMEOUT );
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
					$lock_dir,
					$now,
					$stale_to,
					null,
					null
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
				// Flat layout: the Consumer's recorded `source_log` IS the concrete
				// physical partition dir (`firehose.p0`) — already the catalog
				// entry's name, so the dashboard's rate keys line up. Two readers of
				// one log keep this shared physical name (cursor identity stays
				// per-reader via source_basename below). Fall back to the offset-dir
				// concrete name only for pre-source_log checkpoints.
				$input_log = '' !== $row['source_log']
					? $row['source_log']
					: "{$row['source_basename']}.p{$partition}";
				// Each Consumer can have multiple downstream processors
				// (Tee fan-out: firehose:tee → request-builder + job-router).
				// Emit one dashboard row per processor so the operator sees
				// the actual work units, not the Consumer plumbing.
				$targets = ! empty( $row['targets'] )
					? $row['targets']
					: [ [ 'name' => $row['target'] ] ];
				foreach ( $targets as $t ) {
					$handler   = self::to_string( $t['name'] ?? '' );
					$target_nm = isset( $t['name'] ) ? self::to_string( $t['name'] ) : null;
					$worker    = self::build_worker_status(
						$type,
						$partition,
						$input_log,
						$target_nm,
						$lock_dir,
						$now,
						$stale_to,
						$handler,
						[
							'seg'    => self::to_int( $row['seg'] ),
							'off'    => self::to_int( $row['off'] ),
							'behind' => self::to_int( $row['behind'] ),
							'total'  => self::to_int( $row['total'] ),
						]
					);
					$worker['target']         = $t['name'] ?? '';
					$worker['source']         = $row['name'];
					$worker['inputs']         = [ $input_log ];
					$worker['outputs']        = [];
					$worker['inputs_status']  = [
						self::build_log_status_entry(
							$input_log,
							$partition,
							self::to_int( $worker['cursor_seg'] ),
							self::to_int( $worker['cursor_offset'] ),
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

		// Per-log catalog, resolver-driven: one concrete single-partition entry
		// per declared partition dir (`requests.p0`), enumerated from each active
		// topology's resolved resource dirs. No padding, no synthesized empty
		// slots; on-disk orphans the GC will reap are NOT surfaced (consistent
		// with the dashboard's don't-show-doomed-logs behavior). Cursor data is
		// overlaid by the frontend from `workers[]`.
		//
		// Build a `{basename => int}` overrides map across every active
		// topology so each log entry reflects the literal `segment_size`
		// declared in TSL (e.g. `completed` / `gyroscope` hardcoded to 1 MiB)
		// instead of the global config default. Token-substituted
		// (`<config:segment_size>`) Partition lines contribute nothing here;
		// `enumerate_logs` falls back to `$segment_size` for those.
		$segment_size_overrides = self::collect_segment_size_overrides();
		$logs                   = self::enumerate_logs( $log_base, $segment_size, $segment_size_overrides );

		return [
			'workers'        => $workers,
			'supervisor'     => $supervisor,
			'logs'           => $logs,
			'num_partitions' => $num_partitions,
			'num_segments'   => $num_segments,
			'segment_size'   => $segment_size,
			'timestamp'      => $now,
			'heartbeat_interval_s' => Worker_Base::HEARTBEAT_INTERVAL_S,
		];
	}

	/**
	 * Build the per-worker rich descriptor, adding `live`/`stale`/`heartbeat_at`
	 * from the heartbeat mtime so the dashboard renders status badges in one round-trip.
	 *
	 * @param array{seg:int,off:int,behind:int,total:int}|null $cursor The reader's
	 *     TopicProbe snapshot (cursor + backlog + partition-end, all from the same
	 *     instant, via `consumer_rows()`); null for a not-yet-checkpointed placeholder.
	 * @return array<string, mixed>
	 */
	private static function build_worker_status(
		string $type,
		int $partition,
		string $input_log,
		?string $output_log,
		string $lock_dir,
		int $now,
		int $stale_timeout,
		?string $handler_name,
		?array $cursor = null
	): array {
		// Cursor, backlog (`behind`) and partition-end (`total_size`) ALL come from
		// the reader's TopicProbe record — captured in ONE snapshot (cursor vs end
		// at the same instant), passed in via the consumer_rows row. NO fresh
		// get_segments: comparing a ~15s-old cursor against a freshly-statted end
		// falsely inflates the lag (the partition grew since the snapshot), which is
		// exactly what made a caught-up consumer look behind. Per-reader by
		// offset_dir, so two readers of one log keep separate cursors.
		$cursor_seg    = $cursor['seg'] ?? 0;
		$cursor_offset = $cursor['off'] ?? 0;
		$behind        = $cursor['behind'] ?? 0;
		$total_size    = $cursor['total'] ?? 0;

		// Status: heartbeat freshness inside the lock dir.
		$status        = 'dead';
		$heartbeat_age = null;
		$heartbeat_at  = 0;
		$hb_file       = $lock_dir . '/heartbeat';
		if ( \file_exists( $hb_file ) ) {
			$mtime = @\filemtime( $hb_file );
			if ( false !== $mtime ) {
				$heartbeat_at  = $mtime;
				$heartbeat_age = $now - $mtime;
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
	 *
	 * @return array<string, mixed>
	 */
	private static function build_supervisor_status( string $lock_dir, int $now ): array {
		$status        = 'dead';
		$heartbeat_age = null;
		$hb_file       = $lock_dir . '/heartbeat';
		if ( \file_exists( $hb_file ) ) {
			$mtime = @\filemtime( $hb_file );
			if ( false !== $mtime ) {
				$heartbeat_age = $now - $mtime;
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
	 * The active topology catalog (`name => cfg`), or `[]` if the substrate
	 * isn't loaded / the lookup throws. Shared preamble for every per-topology
	 * collector below so the class_exists/try-catch contract lives in one place.
	 *
	 * @return array<string,mixed>
	 */
	private static function active_topologies(): array {
		if ( ! \class_exists( '\\Newspack_Nodes\\Bootstrap' ) ) {
			return [];
		}
		try {
			return Bootstrap::get_topologies();
		} catch ( \Throwable $e ) {
			return [];
		}
	}

	/**
	 * Per-topology structural graph for every active topology: name =>
	 * `Topology_Registry::graph_for( name )` (`{nodes, edges}`). The dashboard
	 * renders the .tsl graph alongside the live fleet so operators see node
	 * wiring next to worker status.
	 *
	 * @return array<string,array{nodes: list<array<string,int|string|list<string>>>, edges: list<array{0:string,1:string}>}>
	 */
	private static function collect_topology_graphs(): array {
		$graphs = [];
		foreach ( self::active_topologies() as $name => $_cfg ) {
			$graphs[ $name ] = Topology_Registry::graph_for( $name );
		}
		return $graphs;
	}

	/**
	 * Build `logs` catalog entries for every active topology's `Log` file-sink
	 * (kind 'log' in `graph_for`). Each Log writes a single rotated file, not a
	 * partitioned segment dir, so its entry is synthesized by stat'ing the live
	 * file + its rotation siblings: the current file gets the highest segment id
	 * (matching the dashboard's `newestSegId = max(id)`), older rotations descend
	 * by mtime. `segment_size` carries the Log's `max_size` so the bar scales.
	 *
	 * Skips sinks whose `<config:KEY>` path can't resolve, and never clobbers an
	 * existing segmented-log entry on a basename collision.
	 *
	 * @param array<array-key,mixed> $logs Existing catalog (each entry `{name,partitions,segment_size}`).
	 * @return array<array-key,mixed> $logs + Log sink entries.
	 */
	private static function append_log_sinks( array $logs ): array {
		$existing = [];
		foreach ( $logs as $log ) {
			if ( \is_array( $log ) && isset( $log['name'] ) && \is_scalar( $log['name'] ) ) {
				$existing[ (string) $log['name'] ] = true;
			}
		}
		foreach ( self::collect_topology_graphs() as $graph ) {
			foreach ( $graph['nodes'] as $node ) {
				if ( 'log' !== ( $node['kind'] ?? '' ) || ! isset( $node['path'] ) || ! \is_scalar( $node['path'] ) ) {
					continue;
				}
				$path = self::resolve_path_token( (string) $node['path'] );
				if ( '' === $path ) {
					continue;
				}
				$name = \basename( $path );
				if ( isset( $existing[ $name ] ) ) {
					continue;
				}
				$existing[ $name ] = true;
				$logs[]            = self::build_log_sink_entry(
					$path,
					$name,
					self::to_int( $node['segment_size'] ?? 0 )
				);
			}
		}
		return $logs;
	}

	/**
	 * Synthesize a one-partition catalog entry for a Log sink: stat the flat
	 * `{file}.{seg}` monotonic segments, deriving each id from the numeric
	 * suffix (highest id = current/newest).
	 *
	 * @return array{name:string,partitions:array<int,mixed>,segment_size:int}
	 */
	private static function build_log_sink_entry( string $path, string $name, int $segment_size ): array {
		$files = \glob( $path . '.[0-9]*' ) ?: [];

		$segments   = [];
		$total_size = 0;
		foreach ( $files as $file ) {
			if ( ! \preg_match( '/\.(\d+)$/', $file, $m ) ) {
				continue;
			}
			$size       = @\filesize( $file );
			$mtime      = @\filemtime( $file );
			$size       = false !== $size ? $size : 0;
			$segments[] = [
				'id'    => (int) $m[1],
				'size'  => $size,
				'mtime' => false !== $mtime ? $mtime : 0,
			];
			$total_size += $size;
		}
		\usort( $segments, static fn ( array $a, array $b ): int => $a['id'] <=> $b['id'] );

		return [
			'name'         => $name,
			'partitions'   => [
				[
					'partition'  => 0,
					'segments'   => $segments,
					'total_size' => $total_size,
				],
			],
			'segment_size' => $segment_size,
		];
	}

	/** Resolve any `<config:KEY>` tokens in a Log path; '' if a token can't resolve. */
	private static function resolve_path_token( string $path ): string {
		return Core::resolve_config_tokens( $path );
	}

	/**
	 * Union the per-Partition `segment_size` overrides across every active
	 * topology (last-write-wins on basename collision).
	 *
	 * @return array<string,int> `{basename => int}` (basename without `.log`).
	 */
	private static function collect_segment_size_overrides(): array {
		$out = [];
		foreach ( self::active_topologies() as $name => $_cfg ) {
			$overrides = Topology_Registry::segment_size_overrides_for( $name );
			foreach ( $overrides as $basename => $size ) {
				$out[ $basename ] = $size;
			}
		}
		return $out;
	}

	/**
	 * Enumerate the flat partition-in-name log layout: for every active topology,
	 * ask the layout-agnostic resolver
	 * (`Topology_Registry::resolved_resource_dirs`) for its concrete per-partition
	 * log dir names, then stat each dir's segments. Emits ONE flat entry per
	 * concrete dir, NAMED by that dir (`requests.p0`) and carrying that single
	 * partition's data. The resolver's 0..N-1 expansion already enumerates every
	 * partition dir, present or not (a missing dir stats to empty segments) — no
	 * `.p{N}` parsing, no padding math here. Then unions the request-scope PHP
	 * producer dirs (`Log_Cleaner::producer_log_dirs`) — firehose / jobintake,
	 * declared in no .tsl — so the dashboard's `firehose.p{N}` vertex resolves.
	 * Per-log `segment_size` honors any TSL literal override (keyed by the
	 * override basename when the concrete name starts with it).
	 *
	 * @param array<string,int> $segment_size_overrides `{basename => int}` map.
	 * @return array<int,array{name:string,partitions:array<int, mixed>,segment_size:int}>
	 */
	private static function enumerate_logs(
		string $log_base,
		int $default_segment_size,
		array $segment_size_overrides
	): array {
		$logs = [];
		$seen = [];
		$add  = function ( string $concrete ) use ( &$logs, &$seen, $log_base, $segment_size_overrides, $default_segment_size ): void {
			if ( isset( $seen[ $concrete ] ) ) {
				return;
			}
			$seen[ $concrete ] = true;
			$status            = self::build_log_status_entry( $concrete, 0, null, null, $log_base );
			$logs[]            = [
				'name'         => $concrete,
				'partitions'   => [
					[
						'partition'  => 0,
						'segments'   => $status['segments'] ?? [],
						'total_size' => $status['total_size'] ?? 0,
					],
				],
				'segment_size' => self::segment_size_for( $concrete, $segment_size_overrides, $default_segment_size ),
			];
		};
		foreach ( self::active_topologies() as $name => $_cfg ) {
			$resolved = Topology_Registry::resolved_resource_dirs( $name, Bootstrap::num_partitions_for( $name ) );
			foreach ( $resolved['logs'] as $concrete ) {
				$add( $concrete );
			}
		}
		// Request-scope PHP producers (firehose / jobintake — Log_Manager /
		// Job_Intake) are declared in no .tsl, so the topology loop never yields
		// their dirs. Union them from the same source the GC reads so the
		// dashboard's `firehose.p{N}` vertex resolves to a concrete entry.
		foreach ( Log_Cleaner::producer_log_dirs() as $concrete ) {
			$add( $concrete );
		}
		return $logs;
	}

	/**
	 * Pick the per-log `segment_size`: a TSL literal override applies to a concrete
	 * partition dir when the dir name starts with the override basename AND a word
	 * boundary follows it (the override is keyed by basename; the concrete name
	 * carries the partition token inline as `{basename}.p{N}`). The word-boundary
	 * test stops a prefix override from bleeding onto a sibling — `job` matches
	 * `job.p0` (next char `.`) but not `jobs.p0` (next char `s`). Falls back to the
	 * global default.
	 *
	 * @param array<string,int> $segment_size_overrides `{basename => int}` map.
	 */
	private static function segment_size_for( string $concrete, array $segment_size_overrides, int $default_segment_size ): int {
		foreach ( $segment_size_overrides as $basename => $size ) {
			if ( '' === $basename || 0 !== \strpos( $concrete, $basename ) ) {
				continue;
			}
			$next = $concrete[ \strlen( $basename ) ] ?? '';
			if ( '' === $next || 1 !== \preg_match( '/[A-Za-z0-9_-]/', $next ) ) {
				return $size;
			}
		}
		return $default_segment_size;
	}

	/**
	 * Scan a flat concrete log dir and return the per-log status block for
	 * `inputs_status` / `outputs_status`. Cursor fields included only when both
	 * `$cursor_seg` and `$cursor_offset` are non-null (else the UI treats it as output-only).
	 *
	 * @return array<string, mixed>
	 */
	private static function build_log_status_entry(
		string $log_name,
		int $partition,
		?int $cursor_seg,
		?int $cursor_offset,
		string $log_base
	): array {
		$segment_dir = "{$log_base}/{$log_name}";
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
							'size'  => false !== $size ? $size : 0,
							'mtime' => false !== $mtime ? $mtime : 0,
						];
						$total_size += false !== $size ? $size : 0;
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
	 * One row per active Consumer, via the canonical per-Consumer enumeration
	 * (`CLI::consumer_rows()`, sourced from the TopicProbe log) — shared with
	 * `wp nodes status` so the dashboard and cli read positions exactly one way.
	 *
	 * @return array<int,array{name:string,target:string,targets:array<int,array<string,mixed>>,worker_type:string,source_basename:string,source_log:string,partition:int,seg:int,off:int,behind:int,total:int,ts:float}>
	 */
	private static function enumerate_offsetlog_rows( string $base_dir ): array {
		return ( new CLI( $base_dir ) )->consumer_rows();
	}

	/**
	 * Coerce a mixed value to int, reproducing PHP's `(int)` cast
	 * (null→0, scalar→its int form, non-empty array→1) without a mixed-cast.
	 *
	 * @param mixed $v Raw value.
	 */
	private static function to_int( $v ): int {
		if ( null === $v ) {
			return 0;
		}
		if ( \is_array( $v ) ) {
			return empty( $v ) ? 0 : 1;
		}
		if ( \is_object( $v ) ) {
			return 1;
		}
		if ( \is_scalar( $v ) ) {
			return (int) $v;
		}
		return 0;
	}

	/**
	 * Coerce a mixed value to string, reproducing PHP's `(string)` cast
	 * (null→'', scalar→its string form, array→'Array') without a mixed-cast.
	 *
	 * @param mixed $v Raw value.
	 */
	private static function to_string( $v ): string {
		if ( \is_string( $v ) ) {
			return $v;
		}
		if ( null === $v ) {
			return '';
		}
		if ( \is_array( $v ) ) {
			return 'Array';
		}
		if ( \is_object( $v ) ) {
			return $v instanceof \Stringable ? $v->__toString() : '';
		}
		if ( \is_scalar( $v ) ) {
			return (string) $v;
		}
		return '';
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Worker fleet control: list workers, dump operator metadata, audit/cleanup orphans, restart, and refresh SSE slot heartbeats.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list',
					'description' => 'List workers with live positions.',
					'args'        => [],
					// $self is the dispatching interpreter instance — always a Workers_CI_Node here
					// (dispatch() passes $this), so it's typed concretely to read the
					// ctor-injected cli/cache off it (node_schema is static, can't `use` them).
					'handler'     => static function ( Workers_CI_Node $self, string $args, array $envelope = [] ): array {
						$cli     = $self->cli();
						$workers = $cli->ls_workers();
						$index   = $cli->read_probe_index();
						foreach ( $workers as &$w ) {
							$w['position'] = $cli->live_position( $index, $w['type'], $w['partition'] );
						}
						unset( $w );
						return $workers;
					},
				],
				[
					'name'        => 'dump_graph',
					'description' => 'Full operator-grade fleet/supervisor/log metadata + per-topology .tsl graph.',
					'args'        => [],
					'handler'     => static function ( Workers_CI_Node $self, string $args, array $envelope = [] ): array {
						$payload          = self::collect_dump_metadata();
						$payload['graph'] = self::collect_topology_graphs();
						$payload['logs']  = self::append_log_sinks( (array) $payload['logs'] );
						return $payload;
					},
				],
				[
					'name'        => 'cleanup_status',
					'description' => 'Report orphaned worker artifacts vs the expected fleet.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
						// Diagnostic: surface what Log_Cleaner reads when deciding which
						// flat log dirs to delete, so operators can debug orphan-log sweeps.
						$base_dir = RuntimeConfig::get_base_directory();
						$logs_dir = $base_dir . '/logs';
						$on_disk  = [];
						// Mirror Log_Cleaner::sweep(): glob first-level dirs (GLOB_ONLYDIR,
						// layout-agnostic — no `.p{N}` regex) so the diagnostic matches
						// exactly what the GC would delete.
						foreach ( @\glob( $logs_dir . '/*', \GLOB_ONLYDIR ) ?: [] as $dir ) {
							$on_disk[] = \basename( $dir );
						}
						\sort( $on_disk );
						// Same code path Log_Cleaner's sweep uses so the diagnostic
						// matches the actual declared set (topology declarations +
						// the registered_log_producers filter).
						$expected = Log_Cleaner::declared_log_dirs();
						\sort( $expected );
						$orphans = \array_values( \array_diff( $on_disk, $expected ) );
						return [
							'logs_dir'           => $logs_dir,
							'on_disk_basenames'  => $on_disk,
							'expected_basenames' => $expected,
							'orphans'            => $orphans,
						];
					},
				],
				[
					'name'        => 'restart',
					'description' => 'Restart matching workers (and/or the supervisor): `restart <type>… [--partition=<n>]`.',
					'args'        => [
						[ 'name' => 'types', 'type' => 'string', 'required' => false ],
						[ 'name' => 'partition', 'type' => 'int', 'required' => false, 'default' => -1 ],
					],
					'handler'     => static function ( Workers_CI_Node $self, string $args, array $envelope = [] ): array {
						$parsed    = Command_Args::parse( $args );
						$types     = $parsed['positional'];
						$partition = isset( $parsed['options']['partition'] ) ? (int) $parsed['options']['partition'] : -1;
						$filter    = [];
						foreach ( $types as $t ) {
							$filter[ $t ] = true;
						}
						$restarted = 0;
						// Supervisor lives at `supervisor.lock.d` (no partition
						// suffix); `restart_workers` only knows the `{type}.p{N}`
						// shape, so route the supervisor through its own path.
						$cli = $self->cli();
						if ( isset( $filter['supervisor'] ) && $cli->restart_supervisor() ) {
							++$restarted;
							unset( $filter['supervisor'] );
						}
						if ( ! empty( $filter ) || empty( $types ) ) {
							$restarted += $cli->restart_workers( $cli->ls_workers(), $filter, $partition );
						}
						return [ 'restarted' => $restarted ];
					},
				],
				[
					'name'        => 'heartbeat',
					'description' => "Refresh this session's SSE slot TTL.",
					'args'        => [
						[ 'name' => 'slot', 'type' => 'int', 'required' => true ],
						[ 'name' => 'ttl', 'type' => 'int', 'required' => false, 'default' => 10 ],
						[ 'name' => 'partition', 'type' => 'int', 'required' => false, 'default' => -1 ],
					],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args ): array {
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
				],
			],
		] );
	}
}
