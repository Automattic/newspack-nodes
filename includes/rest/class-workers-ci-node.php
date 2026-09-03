<?php
/**
 * Workers_CI: command-dispatch for worker-lifecycle verbs.
 *
 * Verbs:
 *   list           — one row per worker lock dir (`CLI::ls_workers()`): type,
 *                    partition and heartbeat liveness, nothing else.
 *   dump_graph     — the operator-grade envelope `collect_dump_metadata()`
 *                    builds, plus a `graph` map of active-topology-name =>
 *                    `{nodes, edges}` and a catalog entry for every `Log`
 *                    file-sink. The Worker Status dashboard polls it; it stats
 *                    the whole log tree, so it is the expensive verb here.
 *   cleanup_status — what sits on disk under `logs/`, the set `Log_Cleaner`
 *                    declares, and the orphans between them.
 *   restart        — request a graceful restart of matching worker types.
 *   heartbeat      — refresh the caller's own SSE slot lease.
 *
 * The substrate `CLI` is a public property the bootstrap assigns after
 * `make_node` returns, never a constructor argument — see `$cli`. Nothing else
 * is injected: `SSE_Slot_Pool` selects its tier through
 * `Cache_Backend::shared_first()` at the point of use, so there is no cache
 * handle to hold.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Core;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\SSE_Slot_Pool;
use Newspack_Nodes\Log_Cleaner;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Worker_Base;

\defined( 'ABSPATH' ) || exit;

/**
 * The `workers` service interpreter: fleet liveness, the dashboard envelope,
 * the orphan diagnostic, restart, and SSE slot heartbeats.
 *
 * Every collector is static and reads state fresh, because no caller shares a
 * process with the workers it reports on — a REST request, `Alerts::evaluate()`
 * on the WP-Cron tick and a REPL session each start from disk and cache.
 */
class Workers_CI_Node extends Service_CI_Node {

	/**
	 * The substrate CLI the `list` and `restart` handlers reach through
	 * `cli()`.
	 *
	 * Public because a programmatic dependency arrives as a property
	 * assignment after construction: `make_node` calls a no-arg constructor
	 * and `arguments()` carries scalar tokens only, so an object cannot ride
	 * in as a constructor argument (ADR-11). `node_schema()` is static and
	 * cannot close over an instance field, so its handlers read this off the
	 * `$self` they are handed at dispatch time.
	 *
	 * Nullable with a null default, so an interpreter the bootstrap has not
	 * wired yet holds a defined value and `cli()` throws a named refusal
	 * instead of tripping over an uninitialized typed property.
	 *
	 * The native type stays `object` — a duck-typed seam a test fills with a
	 * fake — while the `@var` names the production class, so static analysis
	 * still sees the worker-control methods the handlers call.
	 *
	 * @var \Newspack_Nodes\CLI|null
	 */
	public ?object $cli = null;

	/**
	 * `dump_graph` verb handler — the fleet snapshot the Worker Status
	 * dashboard renders.
	 *
	 * Three reads compose into ONE reply because the browser joins them:
	 * `collect_dump_metadata()` for live state, `collect_topology_graphs()`
	 * for the declared `.tsl` structure, and `append_log_sinks()` for the Log
	 * file-sinks the partitioned catalog does not cover. Separately timed verbs
	 * would let a slow poll join a worker list against a graph and a segment
	 * list captured at other instants.
	 *
	 * @return array<int|string,mixed>
	 */
	public static function cmd_dump_graph(): array {
		$payload          = self::collect_dump_metadata();
		$payload['graph'] = self::collect_topology_graphs();
		$payload['logs']  = self::append_log_sinks( (array) $payload['logs'] );
		return $payload;
	}

	/**
	 * Build the operator-grade envelope.
	 *
	 * Public so `Alerts::evaluate()` reads the SAME `workers[]`, `consumers[]`
	 * and `deadletter_by_reader` snapshot the dashboard does. The alternative
	 * is a second implementation of the lock-dir, heartbeat and probe reads —
	 * two copies that drift, until an alert names a fleet the dashboard does
	 * not show.
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
			$stale_to  = Lock_Node::stale_timeout_of( $w );
			$workers[] = self::build_worker_status(
				$type,
				$partition,
				"{$locks_base}/{$type}.p{$partition}.lock.d",
				$now,
				$stale_to,
				Bootstrap::on_demand_idle_of( $w )
			);
		}

		// Per-reader probe STATE (cursor, end, distance), keyed by reader.
		$consumers = self::enumerate_offsetlog_rows( $base_dir );

		// Per-log catalog, resolver-driven; segment_size honors TSL overrides.
		$segment_size_overrides = self::collect_segment_size_overrides();
		$logs                   = self::enumerate_logs( $log_base, $segment_size, $segment_size_overrides );

		// On-disk log partitions: glob .pN dirs fresh (layout-agnostic).
		$log_partitions = \count( @\glob( "{$log_base}/*", \GLOB_ONLYDIR ) ?: [] );

		$deadletter_by_reader = self::deadletter_segments_by_reader( $base_dir );

		return [
			'workers'        => $workers,
			'consumers'      => $consumers,
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
	 * @param string $base_dir Substrate base directory.
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
	 * Build one worker's liveness descriptor (`status`, `live`, `stale`,
	 * `idle`, `heartbeat_at`) from its lock-dir heartbeat mtime, so the
	 * dashboard renders every status badge from a single round trip.
	 *
	 * `idle` is the derived conjunction every consumer wants — an on-demand
	 * worker that is cleanly absent, as opposed to one that died holding its
	 * lock. Deriving it once here keeps alerting and the dashboards from each
	 * re-deciding what absence means.
	 *
	 * @param string $type           Worker type: the fleet name its lock dir is keyed by.
	 * @param int    $partition      Partition index this worker owns.
	 * @param string $lock_dir       Absolute path of the worker's lock dir.
	 * @param int    $now            Wall clock the heartbeat age is measured against.
	 * @param int    $stale_timeout  Seconds without a heartbeat before the lock reads stale.
	 * @param int    $on_demand_idle Idle window the topology declares; 0 means resident.
	 * @return array<string,mixed>
	 */
	private static function build_worker_status(
		string $type,
		int $partition,
		string $lock_dir,
		int $now,
		int $stale_timeout,
		int $on_demand_idle = 0
	): array {
		// Pure liveness per (type, partition) from the lock-dir heartbeat.
		$status        = 'dead';
		$heartbeat_age = null;
		$heartbeat_at  = 0;
		$mtime = @\filemtime( $lock_dir . '/heartbeat' );
		if ( false !== $mtime ) {
			$heartbeat_at  = $mtime;
			$heartbeat_age = $now - $mtime;
			if ( ! Lock_Node::heartbeat_is_stale( $lock_dir, $now, $stale_timeout ) ) {
				$status = 'running';
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
			'idle'            => $on_demand_idle > 0 && ! $live && ! $stale,
			'restart_pending' => Lock_Node::is_restart_pending( $lock_dir ),
		];
	}

	/**
	 * Add a `logs` catalog entry for every active topology's `Log` file-sink
	 * (kind `log` in `graph_for`).
	 *
	 * A Log writes flat `{file}.{seg}` rotations rather than a partitioned
	 * segment dir, so `enumerate_logs()` never sees one and its entry is
	 * synthesized here. `segment_size` carries the Log's own positional
	 * `segment_size` argument, so the dashboard's segment bar scales to that
	 * Log instead of to the fleet default.
	 *
	 * A sink whose path resolves to nothing is skipped, and a basename already
	 * in the catalog is left alone — a real segmented-log entry outranks a
	 * synthesized one.
	 *
	 * @param array<array-key,mixed> $logs Existing catalog (each entry `{name,partitions,segment_size}`).
	 * @return array<array-key,mixed> $logs plus one entry per Log sink.
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
	 * The structural graph of every active topology: name =>
	 * `Topology_Analyzer::graph_for( name )` (`{nodes, edges}`). The dashboard
	 * renders the `.tsl` wiring alongside the live fleet, so an operator reads
	 * node structure next to worker status.
	 *
	 * @return array<string,array{nodes: list<array<string,int|string|list<string>>>,edges: list<array{0:string,1:string}>}>
	 */
	private static function collect_topology_graphs(): array {
		$graphs = [];
		foreach ( self::active_topologies() as $name => $_cfg ) {
			$graphs[ $name ] = Topology_Analyzer::graph_for( $name );
		}
		return $graphs;
	}

	/**
	 * Synthesize the one-partition catalog entry for a Log sink by stat'ing its
	 * flat `{file}.{seg}` segments, taking each id from the numeric suffix
	 * (highest id = newest). A Log is one rotated file rather than a
	 * per-partition fan-out, so partition 0 is the whole of it.
	 *
	 * The suffix rule restates `Log_Node::segment_pattern()`, the rule the
	 * WRITER matches its own segments with; keep the two in step. Borrowing it
	 * through an ephemeral Log_Node, as `Log_Sources::source_segments()` does,
	 * would drop `mtime` — `Partition_Node::get_segments()` collects id and
	 * size only, and the dashboard needs the mtime.
	 *
	 * @param string $path         Resolved path of the Log, with no segment suffix.
	 * @param string $name         Catalog name; the path's basename.
	 * @param int    $segment_size Rotation size the Log declares, in bytes.
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

	/**
	 * Resolve the `<config:KEY>` tokens in a Log's declared path.
	 *
	 * Non-strict: an unresolvable token becomes '', so a path that is nothing
	 * but a token resolves to '' and `append_log_sinks()` skips that sink.
	 *
	 * @param string $path Raw path token from the topology graph.
	 * @return string The resolved path.
	 */
	private static function resolve_path_token( string $path ): string {
		return Core::resolve_config_tokens( $path );
	}

	/**
	 * Union the per-Partition `segment_size` overrides across every active
	 * topology (last write wins on a dir collision), then let the partitions
	 * built in PHP fill the gaps through the filter.
	 *
	 * @return array<string,int> Concrete first-level log dir, or the filter's bare basename, => bytes.
	 */
	private static function collect_segment_size_overrides(): array {
		$out = [];
		foreach ( self::active_topologies() as $name => $_cfg ) {
			try {
				$overrides = Topology_Analyzer::segment_size_overrides_for( $name, Bootstrap::num_partitions_for( $name ) );
			} catch ( \RuntimeException $e ) {
				// Dormant provider: skip, do not fatal every admin page.
				Core::print_less_often( "segment-size overrides skipped for {$name}: ", $e->getMessage() );
				continue;
			}
			foreach ( $overrides as $basename => $size ) {
				$out[ $basename ] = $size;
			}
		}
		/**
		 * Segment sizes for partitions no topology declares. A Partition built
		 * in PHP — Job_Intake's `jobfeed`, at FEED_SEGMENT_SIZE — has no
		 * `make_node Partition|Topic|Log … <literal size>` statement to read a
		 * size off, so without this the catalog reports the fleet default and
		 * the segment bar draws a full 1 MiB segment against an assumed 64 MiB.
		 * The two sources are disjoint by construction: whatever builds a
		 * partition sets its geometry, and only one thing builds each.
		 *
		 * @param array<string,int> $out Basename => segment size in bytes.
		 */
		// Union keeps the LEFT side: the filter fills gaps, never restates.
		return $out + \apply_filters( 'newspack_nodes/segment_size_overrides', $out );
	}

	/**
	 * The active topology catalog (`name => cfg`), or `[]` when the substrate
	 * is not loaded or the lookup throws. Every per-topology collector in this
	 * class reads through it, so the `class_exists` test and the catch that
	 * degrade an admin page to an empty fleet live in exactly one place.
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
	 * Enumerate the flat partition-in-name log layout: ONE entry per concrete
	 * dir, named by that dir (`requests.p0`), carrying that single partition's
	 * segments and stamped with its REAL enumerated partition.
	 *
	 * The dir list is the GC's declared set
	 * (`Log_Cleaner::declared_log_partitions()`) — one source of truth with the
	 * retention sweep. That set covers every on-disk topology's resolved
	 * per-partition log dirs PLUS the logs no `.tsl` declares: the PHP
	 * producers' firehose and jobintake, and the settings log. Sourcing the
	 * catalog from the set the GC retains is what makes a log a topology only
	 * CONSUMES resolve to a concrete entry showing its segments, rather than
	 * to "No segments". A dir that does not exist stats to empty segments.
	 *
	 * The partition is the resolver's enumeration index, never parsed back out
	 * of a name: the dashboard joins `logs[]` to `consumers[]` on
	 * `${name}#${partition}`, and a hardcoded 0 would meet the consumer rows on
	 * partition 0 alone.
	 *
	 * @param string            $log_base               Absolute `{base}/logs` dir.
	 * @param int               $default_segment_size   Fleet-wide segment size in bytes.
	 * @param array<string,int> $segment_size_overrides `{basename => int}` map.
	 * @return array<int,array{name:string,partitions:array<int,mixed>,segment_size:int}>
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
	 * @param string            $concrete               Concrete log dir name.
	 * @param array<string,int> $segment_size_overrides `{basename => int}` map.
	 * @param int               $default_segment_size   Fleet-wide size in bytes.
	 * @return int Segment size in bytes for this dir.
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
	 * Stat one flat concrete log dir into its `{name, partition, segments,
	 * total_size}` block. A symlinked entry is skipped, so a link dropped into
	 * a log dir cannot report a file outside it as a segment.
	 *
	 * The cursor fields ride along only when both `$cursor_segment` and
	 * `$cursor_offset` are given. The browser joins each reader's cursor from
	 * `consumers[]` when it rebuilds `inputs_status`, so `enumerate_logs()`
	 * passes neither.
	 *
	 * @param string   $log_name       Concrete dir name, e.g. `requests.p0`.
	 * @param int      $partition      Enumerated partition the dir belongs to.
	 * @param int|null $cursor_segment Reader's segment id, or null to omit both fields.
	 * @param int|null $cursor_offset  Reader's byte offset, or null to omit both fields.
	 * @param string   $log_base       Absolute `{base}/logs` dir.
	 * @return array<string,mixed>
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
	 * (`CLI::consumer_rows()`, sourced from the Topic_Probe log) — shared with
	 * `wp nodes status`, so the dashboard and the cli read positions exactly
	 * one way.
	 *
	 * @param string $base_dir Substrate base directory.
	 * @return array<int,array<string,mixed>>
	 */
	private static function enumerate_offsetlog_rows( string $base_dir ): array {
		return ( new CLI( $base_dir ) )->consumer_rows();
	}

	/**
	 * Coerce a mixed value to int the way PHP's `(int)` cast does: null and an
	 * empty array to 0, a scalar to its int form, an object or a non-empty
	 * array to 1.
	 *
	 * Written out branch by branch because static analysis refuses a cast from
	 * `mixed` at this level. The trailing 0 covers the one type no branch names,
	 * a resource, for which no config value has a meaningful int.
	 *
	 * @param mixed $v Raw value.
	 * @return int
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
	 * `heartbeat` verb handler — refresh the caller's own SSE slot lease.
	 *
	 * Both arguments are read through `Core::canonical_decimal()`, which
	 * refuses anything but a canonical decimal. Every other coercion family
	 * resolves a typo to a number, and a slot invented that way names someone
	 * else's lease. `$slot` may be 0; `$owner` may not, because 0 is the
	 * pointer's release tombstone.
	 *
	 * `$owner` is the lease token `SSE_Slot_Pool::acquire()` handed this
	 * stream, not a user id, so a refusal here means the lease is gone — never
	 * that the caller lacks a capability. `SSE_Slot_Pool::inspect()` names
	 * which of its six states caused it, and that name rides out in the throw.
	 *
	 * @param list<string> $args `[ <slot>, <owner> ]`.
	 * @return array<string,mixed>
	 * @throws \RuntimeException On a malformed argument, an unreachable cache backend, or a lease this owner no longer holds.
	 */
	public static function cmd_heartbeat( array $args ): array {
		if ( 2 !== \count( $args ) ) {
			throw new \RuntimeException( 'heartbeat requires exactly <slot> <owner>' );
		}
		$slot = Core::canonical_decimal( $args[0] );
		if ( null === $slot ) {
			throw new \RuntimeException( 'invalid heartbeat slot' );
		}
		$owner = Core::canonical_decimal( $args[1], false );
		if ( null === $owner ) {
			throw new \RuntimeException( 'invalid heartbeat owner' );
		}
		if ( null === Cache_Backend::shared_first() ) {
			throw new \RuntimeException( 'cache not configured' );
		}
		if ( ! SSE_Slot_Pool::touch( SSE_Slot_Pool::namespace_key(), $slot, $owner, SSE_Slot_Pool::ttl() ) ) {
			// Six states share this refusal; inspect() names which.
			$diagnosis = SSE_Slot_Pool::inspect( SSE_Slot_Pool::namespace_key(), $slot, $owner );
			throw new \RuntimeException( \esc_html( 'SSE slot lease not owned: ' . $diagnosis['lease_state'] ) );
		}
		return [ 'success' => true, 'slot' => $slot ];
	}

	/**
	 * The injected CLI, materialized non-null. Fails loud when the bootstrap
	 * did not assign `$cli` before a worker-control verb dispatched.
	 *
	 * @return \Newspack_Nodes\CLI
	 * @throws \RuntimeException When `$cli` was never assigned.
	 */
	public function cli(): object {
		if ( null === $this->cli ) {
			throw new \RuntimeException( 'Workers_CI_Node requires an injected cli; bootstrap must assign $cli first' );
		}
		return $this->cli;
	}
	/**
	 * `list` verb handler — one row per worker lock dir, through the injected
	 * CLI, carrying type, partition and heartbeat liveness.
	 *
	 * @param Workers_CI_Node $self The dispatching node, carrying `$cli`.
	 * @return array<int|string,mixed>
	 */
	public static function cmd_list( Workers_CI_Node $self ): array {
		return $self->cli()->ls_workers();
	}

	/**
	 * `cleanup_status` verb handler — the orphan-log diagnostic.
	 *
	 * Reports the first-level dirs on disk under `logs/`, the set
	 * `Log_Cleaner` declares, and the difference. Both halves come from the
	 * calls the sweep itself makes, so this names the dirs the sweep deletes
	 * rather than offering a second opinion about them. `orphans` are
	 * candidates, not casualties: the sweep spares any dir written inside its
	 * `DELETE_GRACE_S` window, and this diagnostic applies no such grace.
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
	 * `restart` verb handler — request a graceful restart of matching workers.
	 *
	 * Naming no type — or the literal `all` — matches every worker, and
	 * `--partition` defaults to -1, every partition. The option is read
	 * through `require_option_int()`, which throws on a malformed value. The
	 * coercion families all resolve `--partition=abc` to 0, restarting p0 and
	 * reporting success.
	 *
	 * @param Workers_CI_Node $self The dispatching node, carrying `$cli`.
	 * @param list<string>    $args `[ <type>…, --partition=<n> ]` tokens.
	 * @return array<string,mixed>
	 */
	public static function cmd_restart( Workers_CI_Node $self, array $args ): array {
		$parsed = Command_Args::parse( $args );
		$types  = $parsed['positional'];
		// -1 means every partition; a malformed one must not collapse to p0.
		$partition = self::require_option_int( $parsed['options'], 'partition', -1 );
		$filter    = [];
		foreach ( $types as $t ) {
			$filter[ $t ] = true;
		}
		$cli       = $self->cli();
		$restarted = $cli->restart_workers( $cli->ls_workers(), $filter, $partition );
		return [ 'restarted' => $restarted ];
	}

	/**
	 * Declare the verb surface once: `Service_CI_Node` derives the dispatch
	 * table, the capability gate, `help` and the console palette entry from
	 * this array.
	 *
	 * `restart` declares no `capability` and so gates at MANAGE, the strictest
	 * role — it stops processes. The other four declare READ so a dashboard
	 * can poll them, `heartbeat` included: it refreshes a lease the caller
	 * already holds and can reach no other.
	 *
	 * `category` replaces the `Hidden` inherited from the interpreter, which
	 * is what lists this class in the console palette beside the other service
	 * CIs. `arguments` is empty: `make_node` hands this node nothing, and the
	 * CLI arrives as a property assignment instead.
	 *
	 * @api Used by substrate.
	 * @return array<string,mixed> This class's schema merged over the interpreter's.
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Worker fleet control: list workers, dump operator metadata, audit/cleanup orphans, restart, and refresh SSE slot heartbeats.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list',
					'capability'  => Capabilities::READ,
					'description' => 'List workers with heartbeat liveness.',
					'args'        => [],
					// $self is the Workers_CI_Node; reads its injected cli.
					'handler'     => static fn ( Workers_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_list( $self ),
				],
				[
					'name'        => 'dump_graph',
					'capability'  => Capabilities::READ,
					'description' => 'Full operator-grade fleet/log metadata + per-topology .tsl graph.',
					'args'        => [],
					'handler'     => static fn ( Workers_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_dump_graph(),
				],
				[
					'name'        => 'cleanup_status',
					'capability'  => Capabilities::READ,
					'description' => 'Report orphaned worker artifacts vs the expected fleet.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_cleanup_status(),
				],
				[
					'name'        => 'restart',
					'description' => 'Restart matching workers: `restart <type>… [--partition=<n>]`.',
					'args'        => [
						[ 'name' => 'types', 'type' => 'string', 'required' => false ],
						[ 'name' => 'partition', 'type' => 'int', 'required' => false, 'default' => -1 ],
					],
					'handler'     => static fn ( Workers_CI_Node $self, array $args, array $envelope = [] ): array => self::cmd_restart( $self, self::arg_strings( $args ) ),
				],
				[
					'name'        => 'heartbeat',
					'capability'  => Capabilities::READ,
					'description' => "Refresh this session's SSE slot TTL.",
					'args'        => [
						[ 'name' => 'slot', 'type' => 'int', 'required' => true ],
						[ 'name' => 'owner', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_heartbeat( self::arg_strings( $args ) ),
				],
			],
		] );
	}

}
