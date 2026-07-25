<?php
/**
 * Workers_CI: command-dispatch for worker-lifecycle verbs.
 *
 * Verbs:
 *   list           — minimal worker enumeration (Cli::ls_workers() projection +
 *                    live cursor positions) for programmatic callers.
 *   dump_graph     — full operator-grade envelope (`{workers[], supervisor,
 *                    logs[], num_partitions, max_segments, segment_size,
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
	 * `dump_graph` verb handler — the worker-graph payload.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_dump_graph(): array {
		$payload          = self::collect_dump_metadata();
		$payload['graph'] = self::collect_topology_graphs();
		$payload['logs']  = self::append_log_sinks( (array) $payload['logs'] );
		return $payload;
	}

	// dump_graph helpers: self-contained static builders for the payload.

	/**
	 * Build the full operator-grade envelope. Public so the substrate Alerts
	 * evaluator reads the SAME `{workers[], consumers[], supervisor,
	 * deadletter_segments}` snapshot without re-implementing the lock-dir /
	 * heartbeat / probe reads.
	 *
	 * @return array<string,mixed> Envelope ready for wp_json_encode.
	 */
	public static function collect_dump_metadata(): array {
		$now            = \time();
		$num_partitions = self::to_int( RuntimeConfig::value( 'num_partitions' ) );
		// TRUE disk ceiling: the hard cap (or its 2x num_segments default).
		$max_segments   = \Newspack_Nodes\Partition_Node::derive_max_segments(
			self::to_int( RuntimeConfig::value( 'num_segments' ) ),
			self::to_int( RuntimeConfig::value( 'max_segments' ) )
		);
		$segment_size   = self::to_int( RuntimeConfig::value( 'segment_size' ) );
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

		// workers[] is pure per-(type,partition) liveness; no per-consumer.
		$workers = [];
		foreach ( $descriptors as $w ) {
			$type      = $w['type'];
			$partition = $w['partition'];
			if ( '' === $type ) {
				continue;
			}
			$stale_to  = self::to_int( $w['stale_timeout'] ?? Lock_Node::STALE_TIMEOUT );
			$workers[] = self::build_worker_status(
				$type,
				$partition,
				"{$locks_base}/{$type}.p{$partition}.lock.d",
				$now,
				$stale_to
			);
		}

		// Per-reader probe STATE (cursor, end, distance), keyed by reader.
		$consumers = self::enumerate_offsetlog_rows( $base_dir );

		// Supervisor status: singleton at supervisor.lock.d/ (no partition).
		$supervisor = self::build_supervisor_status( "{$locks_base}/supervisor.lock.d", $now );

		// Per-log catalog, resolver-driven; segment_size honors TSL overrides.
		$segment_size_overrides = self::collect_segment_size_overrides();
		$logs                   = self::enumerate_logs( $log_base, $segment_size, $segment_size_overrides );

		// On-disk log partitions: glob .pN dirs fresh (layout-agnostic).
		$log_partitions = \count( @\glob( "{$log_base}/*", \GLOB_ONLYDIR ) ?: [] );

		$deadletter_by_reader = self::deadletter_segments_by_reader( $base_dir );

		return [
			'workers'        => $workers,
			'consumers'      => $consumers,
			'supervisor'     => $supervisor,
			'logs'           => $logs,
			'log_partitions' => $log_partitions,
			'deadletter_segments'  => \array_sum( $deadletter_by_reader ),
			'deadletter_by_reader' => $deadletter_by_reader,
			'num_partitions' => $num_partitions,
			'max_segments'   => $max_segments,
			'segment_size'   => $segment_size,
			'timestamp'      => $now,
			'heartbeat_interval_s' => Worker_Base::HEARTBEAT_INTERVAL_S,
		];
	}

	/**
	 * Quarantined dead-letter segments per consumer, from each reader's
	 * `{base}/deadletter/<reader>/{seg}.log` sibling — the DLQ-growth signal,
	 * keyed by the owning reader so alerts can name the queue. Readers with
	 * an empty (fully triaged) dir are omitted; absent dirs glob to nothing.
	 *
	 * @return array<string,int> Reader id => quarantined segment count.
	 */
	private static function deadletter_segments_by_reader( string $base_dir ): array {
		$by_reader = [];
		foreach ( @\glob( "{$base_dir}/deadletter/*/*.log" ) ?: [] as $segment ) {
			$reader               = \basename( \dirname( $segment ) );
			$by_reader[ $reader ] = ( $by_reader[ $reader ] ?? 0 ) + 1;
		}
		\ksort( $by_reader );
		return $by_reader;
	}

	/**
	 * Build one worker's liveness descriptor (`status`/`live`/`stale`/`heartbeat_at`)
	 * from the lock-dir heartbeat mtime, so the dashboard renders status badges in
	 * one round-trip.
	 *
	 * @return array<string, mixed>
	 */
	private static function build_worker_status(
		string $type,
		int $partition,
		string $lock_dir,
		int $now,
		int $stale_timeout
	): array {
		// Pure liveness per (type, partition) from the lock-dir heartbeat.
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
		$live  = ( 'running' === $status );
		$stale = ( ! $live && null !== $heartbeat_age );

		return [
			'type'            => $type,
			'partition'       => $partition,
			'status'          => $status,
			'started_at'      => Lock_Node::get_started_time( $lock_dir ),
			'heartbeat_age'   => $heartbeat_age,
			'heartbeat_at'    => $heartbeat_at,
			'live'            => $live,
			'stale'           => $stale,
			'restart_pending' => Lock_Node::is_restart_pending( $lock_dir ),
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
			try {
				$overrides = Topology_Registry::segment_size_overrides_for( $name );
			} catch ( \RuntimeException $e ) {
				// Dormant provider: skip, do not fatal every admin page.
				Core::print_less_often( "segment-size overrides skipped for {$name}: ", $e->getMessage() );
				continue;
			}
			foreach ( $overrides as $basename => $size ) {
				$out[ $basename ] = $size;
			}
		}
		return $out;
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
	 * Enumerate the flat partition-in-name log layout, ONE flat entry per concrete
	 * dir (NAMED by that dir, e.g. `requests.p0`, carrying that single partition's
	 * segments) stamped with its REAL enumerated partition. The dir list is the
	 * GC's declared set (`Log_Cleaner::declared_log_partitions`) — ONE source of
	 * truth with the sweep:
	 * every on-disk topology's resolved per-partition log dirs PLUS the
	 * externally-written logs no .tsl declares (the PHP producers firehose /
	 * jobintake, the settings log). Sourcing the
	 * catalog from the same set the GC retains means a log a topology only
	 * CONSUMES (written elsewhere) still resolves to a concrete entry and shows
	 * its segments, instead of "No segments". A missing dir stats to empty
	 * segments. Per-log `segment_size` honors any TSL literal override (keyed by
	 * the override basename when the concrete name starts with it).
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
		$add  = function ( string $concrete, int $partition ) use ( &$logs, &$seen, $log_base, $segment_size_overrides, $default_segment_size ): void {
			if ( isset( $seen[ $concrete ] ) ) {
				return;
			}
			$seen[ $concrete ] = true;
			$status            = self::build_log_status_entry( $concrete, $partition, null, null, $log_base );
			$logs[]            = [
				'name'         => $concrete,
				'partitions'   => [
					[
						'partition'  => $partition,
						'segments'   => $status['segments'] ?? [],
						'total_size' => $status['total_size'] ?? 0,
					],
				],
				'segment_size' => self::segment_size_for( $concrete, $segment_size_overrides, $default_segment_size ),
			];
		};
		// Stamp each entry with the REAL enumerated partition, not 0.
		foreach ( Log_Cleaner::declared_log_partitions() as $concrete => $partition ) {
			$add( $concrete, $partition );
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
	 * `$cursor_segment` and `$cursor_offset` are non-null (else the UI treats it as output-only).
	 *
	 * @return array<string, mixed>
	 */
	private static function build_log_status_entry(
		string $log_name,
		int $partition,
		?int $cursor_segment,
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
		if ( null !== $cursor_segment && null !== $cursor_offset ) {
			$entry['cursor_segment']    = $cursor_segment;
			$entry['cursor_offset'] = $cursor_offset;
		}
		return $entry;
	}

	/**
	 * One row per active Consumer, via the canonical per-Consumer enumeration
	 * (`CLI::consumer_rows()`, sourced from the TopicProbe log) — shared with
	 * `wp nodes status` so the dashboard and cli read positions exactly one way.
	 *
	 * @return array<int,array<string,mixed>>
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
	/**
	 * `list` verb handler — the active-worker list via the CLI helper.
	 *
	 * @param Workers_CI_Node $self Verb argument.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_list( Workers_CI_Node $self ): array {
		return $self->cli()->ls_workers();
	}

	/**
	 * `cleanup_status` verb handler — orphan-lock cleanup status snapshot.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_cleanup_status(): array {
		// Diagnostic: what Log_Cleaner reads deciding which dirs to delete.
		$base_dir = RuntimeConfig::get_base_directory();
		$logs_dir = $base_dir . '/logs';
		$on_disk  = [];
		// Mirror Log_Cleaner::sweep(): glob first-level dirs (layout-agnostic).
		foreach ( @\glob( $logs_dir . '/*', \GLOB_ONLYDIR ) ?: [] as $dir ) {
			$on_disk[] = \basename( $dir );
		}
		\sort( $on_disk );
		// Same path Log_Cleaner's sweep uses (topology + producers filter).
		$expected = Log_Cleaner::declared_log_dirs();
		\sort( $expected );
		$orphans = \array_values( \array_diff( $on_disk, $expected ) );
		return [
			'logs_dir'           => $logs_dir,
			'on_disk_basenames'  => $on_disk,
			'expected_basenames' => $expected,
			'orphans'            => $orphans,
		];
	}

	/**
	 * `restart` verb handler — request a graceful restart of matching worker(s).
	 *
	 * @param Workers_CI_Node $self Verb argument.
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_restart( Workers_CI_Node $self, array $args ): array {
		$parsed    = Command_Args::parse( $args );
		$types     = $parsed['positional'];
		$partition = isset( $parsed['options']['partition'] ) ? (int) $parsed['options']['partition'] : -1;
		$filter    = [];
		foreach ( $types as $t ) {
			$filter[ $t ] = true;
		}
		$restarted = 0;
		// Supervisor at supervisor.lock.d (no partition); route it separately.
		$cli = $self->cli();
		if ( isset( $filter['supervisor'] ) && $cli->restart_supervisor() ) {
			++$restarted;
			unset( $filter['supervisor'] );
		}
		if ( ! empty( $filter ) || empty( $types ) ) {
			$restarted += $cli->restart_workers( $cli->ls_workers(), $filter, $partition );
		}
		return [ 'restarted' => $restarted ];
	}

	/**
	 * `heartbeat` verb handler — record a worker slot heartbeat.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_heartbeat( array $args ): array {
		if ( null === Core::$memd ) {
			throw new \RuntimeException( 'cache not configured' );
		}
		$parts = $args;
		$slot  = isset( $parts[0] ) ? (int) $parts[0] : -1;
		if ( $slot < 0 ) {
			throw new \RuntimeException( 'slot required' );
		}
		$ttl     = isset( $parts[1] ) ? (int) $parts[1] : 10;
		$success = SSE_Slot_Pool::touch( SSE_Slot_Pool::hostname(), SSE_Slot_Pool::user_id(), SSE_Slot_Pool::ip_hash(), $slot, $ttl );
		return [ 'success' => $success, 'slot' => $slot ];
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Worker fleet control: list workers, dump operator metadata, audit/cleanup orphans, restart, and refresh SSE slot heartbeats.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list',
					'description' => 'List workers with heartbeat liveness.',
					'args'        => [],
					// $self is the Workers_CI_Node; reads its injected cli.
					'handler'     => static fn ( Workers_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_list( $self ),
				],
				[
					'name'        => 'dump_graph',
					'description' => 'Full operator-grade fleet/supervisor/log metadata + per-topology .tsl graph.',
					'args'        => [],
					'handler'     => static fn ( Workers_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_dump_graph(),
				],
				[
					'name'        => 'cleanup_status',
					'description' => 'Report orphaned worker artifacts vs the expected fleet.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_cleanup_status(),
				],
				[
					'name'        => 'restart',
					'description' => 'Restart matching workers (and/or the supervisor): `restart <type>… [--partition=<n>]`.',
					'args'        => [
						[ 'name' => 'types', 'type' => 'string', 'required' => false ],
						[ 'name' => 'partition', 'type' => 'int', 'required' => false, 'default' => -1 ],
					],
					'handler'     => static fn ( Workers_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_restart( $self, self::arg_strings( $args ) ),
				],
				[
					'name'        => 'heartbeat',
					'description' => "Refresh this session's SSE slot TTL.",
					'args'        => [
						[ 'name' => 'slot', 'type' => 'int', 'required' => true ],
						[ 'name' => 'ttl', 'type' => 'int', 'required' => false, 'default' => 10 ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_heartbeat( self::arg_strings( $args ) ),
				],
			],
		] );
	}

}
