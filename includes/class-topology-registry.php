<?php
/**
 * Topology_Registry — name → .tsl path resolver.
 *
 * Plugins register stock dirs; the writable user dir shadows stock by name.
 * Resolution: user dir first, then each stock dir in registration order.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topology_Registry {

	/** @var array<int,string> Plugin-registered stock dirs (first wins). */
	private static array $stock_dirs = [];

	/** @var string Writable per-deployment user dir. */
	private static string $user_dir = '';

	/** @var array<string,array<string,int>> Memoized per-Partition segment_size overrides by topology name. */
	private static array $segment_size_overrides_cache = [];

	/** @var array<string,array<string>> Memoized write-set by topology name; cleared by reset_basename_cache(). */
	private static array $write_set_cache = [];

	/** @var array<string,array{nodes:list<array<string,int|string|list<string>>>,edges:list<array{0:string,1:string}>}> Memoized structural graph by topology name (node entries carry `type` + `args`). */
	private static array $graph_cache = [];

	/** @var array<string,array<string,string>> Memoized parsed `var` frontmatter by topology name; cleared by reset_basename_cache(). */
	private static array $frontmatter_cache = [];

	/** @var array<string,bool> Guards register_plugin against double-wiring (a second call would double-spawn). */
	private static array $registered_plugins = [];

	/**
	 * Worker-spawn seam for spawn_worker's default handler. Lazily defaulted
	 * to a closure that builds + executes the real Worker_Base. Tests reassign in
	 * setUp to capture the spawn intent without forking a worker process — that
	 * leaves the guard + expand_workers lookup running as real production code.
	 * Signature: `function ( string $type, int $partition, string $topology_name, int $stale_timeout ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $spawn_runner = null;

	/**
	 * `newspack_nodes/topologies` catalog filter: synthesize an entry for every
	 * `.tsl` in `list()` (user-authored + every registered stock dir), so the
	 * catalog reflects what exists on disk, not a per-plugin allowlist. Registered
	 * once by the substrate (newspack-nodes.php). num_partitions defaults to the
	 * operator-overridable substrate option (clamped 1..16); a topology's own
	 * `var num_partitions` frontmatter overrides via synthesize_entry.
	 *
	 * @param array<string, array<string, mixed>> $topologies Existing catalog (a prior contributor wins on key collision).
	 * @return array<string, array<string, mixed>>
	 */
	public static function publish_catalog( array $topologies ): array {
		$cfg        = \Newspack_Nodes\Config::load_config();
		$cfg_np     = $cfg['num_partitions'] ?? 1;
		$default_np = \max( 1, \min( 16, (int) ( \is_scalar( $cfg_np ) ? $cfg_np : 1 ) ) );
		foreach ( self::list() as $name ) {
			if ( isset( $topologies[ $name ] ) ) {
				continue;
			}
			$entry = self::synthesize_entry( $name, $default_np, Lock_Node::STALE_TIMEOUT );
			if ( null !== $entry ) {
				$topologies[ $name ] = $entry;
			}
		}
		return $topologies;
	}

	/**
	 * Return the union of topology names across user + stock dirs.
	 *
	 * @return array<int,string>
	 */
	public static function list(): array {
		$names = [];
		if ( '' !== self::$user_dir && \is_dir( self::$user_dir ) ) {
			foreach ( \glob( self::$user_dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$names[ \basename( $path, '.tsl' ) ] = true;
			}
		}
		foreach ( self::$stock_dirs as $dir ) {
			foreach ( \glob( $dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$names[ \basename( $path, '.tsl' ) ] = true;
			}
		}
		return \array_keys( $names );
	}

	/**
	 * Build a `[topology, num_partitions, stale_timeout]` entry from a TSL's frontmatter; null if unknown.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function synthesize_entry(
		string $name,
		int $default_num_partitions = 1,
		int $default_stale_timeout = Lock_Node::STALE_TIMEOUT
	): ?array {
		if ( null === self::resolve( $name ) ) {
			return null;
		}
		$front = self::frontmatter( $name );
		return [
			'topology'       => $name,
			'num_partitions' => isset( $front['num_partitions'] ) ? (int) $front['num_partitions'] : $default_num_partitions,
			'stale_timeout'  => isset( $front['stale_timeout'] ) ? (int) $front['stale_timeout'] : $default_stale_timeout,
		];
	}

	/**
	 * Return the absolute path to `<name>.tsl` or null if unknown (is_file, not file_exists).
	 */
	public static function resolve( string $name ): ?string {
		if ( '' !== self::$user_dir ) {
			$user_path = self::$user_dir . '/' . $name . '.tsl';
			if ( \is_file( $user_path ) ) {
				return $user_path;
			}
		}
		foreach ( self::$stock_dirs as $dir ) {
			$path = $dir . '/' . $name . '.tsl';
			if ( \is_file( $path ) ) {
				return $path;
			}
		}
		return null;
	}

	/**
	 * Lightweight `var name = value` extractor for supervisor metadata reads (no topology execution).
	 *
	 * @return array<string,string>
	 */
	public static function frontmatter( string $name ): array {
		if ( isset( self::$frontmatter_cache[ $name ] ) ) {
			return self::$frontmatter_cache[ $name ];
		}
		$path = self::resolve( $name );
		if ( null === $path ) {
			return self::$frontmatter_cache[ $name ] = [];
		}
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$contents = (string) \file_get_contents( $path );
		$out      = [];
		foreach ( \explode( "\n", $contents ) as $raw ) {
			// Statements can also be `;`-separated on one line.
			foreach ( \explode( ';', $raw ) as $stmt ) {
				$stmt = \trim( $stmt );
				if ( '' === $stmt || '#' === $stmt[0] ) {
					continue;
				}
				if ( \preg_match( '/^var\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/', $stmt, $m ) ) {
					$out[ $m[1] ] = \trim( $m[2] );
				}
			}
		}
		return self::$frontmatter_cache[ $name ] = $out;
	}

	/**
	 * Pairs of topologies in `$names` whose write-sets overlap — i.e. two worker
	 * processes that would write the same file (data log or cursor) and corrupt
	 * it. Empty array = the set is safe to run together.
	 *
	 * @param array<string> $names
	 * @return array<array{a: string, b: string, shared: array<string>}>
	 */
	public static function find_conflicts( array $names ): array {
		$names = \array_values( \array_unique( $names ) );
		$sets  = [];
		foreach ( $names as $n ) {
			$sets[ $n ] = self::write_set( $n );
		}
		$conflicts = [];
		$count     = \count( $names );
		for ( $i = 0; $i < $count; $i++ ) {
			for ( $j = $i + 1; $j < $count; $j++ ) {
				$a      = $names[ $i ];
				$b      = $names[ $j ];
				$shared = \array_values( \array_intersect( $sets[ $a ], $sets[ $b ] ) );
				if ( ! empty( $shared ) ) {
					$conflicts[] = [
						'a'      => $a,
						'b'      => $b,
						'shared' => $shared,
					];
				}
			}
		}
		return $conflicts;
	}

	/**
	 * Resources `$name` WRITES: its data-partition paths (`make_node Partition`
	 * and `make_node Topic`, which both append to the log at their path arg) and
	 * its Consumer offsetlog paths (`make_node Consumer`'s 2nd arg after the node
	 * name, in the flat layout). Paths are kept in raw token form
	 * (`<config:…>/<basename>.p<partition>`) — identical iff they resolve to the
	 * same file — and namespaced `partition:` / `offsetlog:` so the two kinds can't
	 * false-match. A Consumer's SOURCE (1st arg after the node name) is a read, not
	 * a write, so it's excluded.
	 *
	 * @return array<string>
	 */
	public static function write_set( string $name ): array {
		if ( isset( self::$write_set_cache[ $name ] ) ) {
			return self::$write_set_cache[ $name ];
		}
		$path = self::resolve( $name );
		if ( null === $path ) {
			return self::$write_set_cache[ $name ] = [];
		}
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$contents = (string) \file_get_contents( $path );
		$seen     = [];
		foreach ( \explode( "\n", $contents ) as $raw ) {
			$line = \trim( $raw );
			if ( '' === $line || '#' === $line[0] ) {
				continue;
			}
			// Partition writes one log; Topic appends to the partitions under its
			// path the same way — both share the `partition:` namespace so a
			// Topic-vs-Partition collision on the same log is caught.
			if ( \preg_match( '/^make_node\s+(?:Partition|Topic)\s+\S+\s+(\S+)/', $line, $m ) ) {
				$seen[ 'partition:' . $m[1] ] = true;
				continue;
			}
			// make_node Consumer <node> <source> <offsetlog> — offsetlog is the 2nd token after the node name in the flat layout.
			if ( \preg_match( '/^make_node\s+Consumer\s+\S+\s+\S+\s+(\S+)/', $line, $m ) ) {
				$seen[ 'offsetlog:' . $m[1] ] = true;
			}
		}
		$out = \array_keys( $seen );
		\sort( $out );
		return self::$write_set_cache[ $name ] = $out;
	}

	/**
	 * First-level concrete dir names `$name` writes under logs_dir / offsets_dir,
	 * layout-agnostic: each `write_set` token is expanded over `0..$num_partitions-1`
	 * (substituting BOTH `<partition>` angle and `{partition}` curly), its
	 * `<config:…>` tokens resolved, then the first path segment under the
	 * respective root is taken — wherever the partition token sits in the path.
	 * No `.p{N}` regex. `$num_partitions` is passed by the caller (keeps the
	 * registry free of a Bootstrap dep); pass `Bootstrap::num_partitions_for($name)`.
	 *
	 * Each bucket is a `concrete dir name => enumerated partition index` map; the
	 * partition number comes FROM the enumeration loop, never parsed back out of a
	 * name. In the flat layout (`firehose.p<partition>`) every partition yields a
	 * unique first-level name (1:1). In a nested layout (`<partition>` below the
	 * first level) several partitions collapse to one first-level dir — the FIRST
	 * seen is kept; nested layouts aren't represented per-partition here.
	 *
	 * @return array{logs: array<string,int>, offsets: array<string,int>}
	 */
	public static function resolved_resource_dirs( string $name, int $num_partitions ): array {
		$logs_root    = Core::resolve_config_token( 'config', 'logs_dir' );
		$offsets_root = Core::resolve_config_token( 'config', 'offsets_dir' );
		$logs         = [];
		$offsets      = [];
		foreach ( self::write_set( $name ) as $entry ) {
			[ $kind, $token ] = \explode( ':', $entry, 2 );
			// Explicit kind→(root, bucket) routing so a future non-namespaced
			// write_set entry can't silently land in the offset bucket.
			$root = match ( $kind ) {
				'partition' => $logs_root,
				'offsetlog' => $offsets_root,
				default     => '',
			};
			if ( '' === $root ) {
				continue;
			}
			for ( $p = 0; $p < $num_partitions; $p++ ) {
				$concrete = Core::resolve_partition_template( $token, $p );
				$prefix   = $root . '/';
				if ( 0 !== \strpos( $concrete, $prefix ) ) {
					continue;
				}
				$first = \explode( '/', \substr( $concrete, \strlen( $prefix ) ) )[0];
				if ( '' === $first ) {
					continue;
				}
				// Keep the FIRST partition seen for this name (a nested layout
				// collapses several partitions onto one first-level dir).
				if ( 'partition' === $kind ) {
					$logs[ $first ] ??= $p;
				} else {
					$offsets[ $first ] ??= $p;
				}
			}
		}
		return [
			'logs'    => $logs,
			'offsets' => $offsets,
		];
	}

	/**
	 * Per-Partition literal segment_size overrides from `$name`'s TSL (`{basename => int}`). Memoized.
	 *
	 * Token-substituted values are omitted; the caller falls back to the global default.
	 *
	 * @return array<string,int>
	 */
	public static function segment_size_overrides_for( string $name ): array {
		if ( isset( self::$segment_size_overrides_cache[ $name ] ) ) {
			return self::$segment_size_overrides_cache[ $name ];
		}
		$path = self::resolve( $name );
		if ( null === $path ) {
			return self::$segment_size_overrides_cache[ $name ] = [];
		}
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$contents  = (string) \file_get_contents( $path );
		$overrides = [];
		foreach ( \explode( "\n", $contents ) as $raw ) {
			$line = \trim( $raw );
			if ( '' === $line || '#' === $line[0] ) {
				continue;
			}
			// Capture basename ($m[1]) + segment_size arg ($m[2]); filter on int after the match.
			// In the flat layout segment_size is the FIRST arg after the path (the standalone partition arg is gone).
			if ( ! \preg_match(
				'/^make_node\s+Partition\s+\S+\s+\S*\/([A-Za-z0-9_-]+)\.p<partition>\s+(\S+)/',
				$line,
				$m
			) ) {
				continue;
			}
			if ( \ctype_digit( $m[2] ) ) {
				$overrides[ $m[1] ] = (int) $m[2];
			}
		}
		return self::$segment_size_overrides_cache[ $name ] = $overrides;
	}

	/**
	 * Raw structural graph for `$name` from its TSL: nodes with a class-derived
	 * kind, the make_node `type` token + positional `args` list, (+ the log a
	 * Partition/Topic writes or a Consumer reads, from the path/source ARG — never
	 * a name suffix), and edges from `connect_node` plus
	 * `cmd <node>:config set_*_target <target>`. Memoized.
	 *
	 * @return array{nodes: list<array<string,int|string|list<string>>>, edges: list<array{0:string,1:string}>}
	 */
	public static function graph_for( string $name ): array {
		if ( isset( self::$graph_cache[ $name ] ) ) {
			return self::$graph_cache[ $name ];
		}
		$path = self::resolve( $name );
		if ( null === $path ) {
			return self::$graph_cache[ $name ] = [
				'nodes' => [],
				'edges' => [],
			];
		}
		$kind_of  = static function ( string $cls ): string {
			$kind = match ( $cls ) {
				'Consumer'  => 'consumer',
				'Partition' => 'partition',
				'Topic'     => 'topic',
				'Tee'       => 'tee',
				'Log'       => 'log',
				default     => 'logic',
			};
			// Exact base names hit the match; an unknown type that resolves to a
			// Tee subclass (e.g. Tap) gets the same fan-out 'tee' treatment.
			if ( 'logic' === $kind ) {
				$fqcn = Command_Interpreter_Node::resolve_class( $cls );
				if ( null !== $fqcn && \is_a( $fqcn, Tee_Node::class, true ) ) {
					return 'tee';
				}
			}
			return $kind;
		};
		$basename = static function ( string $arg ): string {
			$slash = \strrpos( $arg, '/' );
			return false === $slash ? $arg : \substr( $arg, $slash + 1 );
		};
		$nodes = [];
		$edges = [];
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		foreach ( \explode( "\n", (string) \file_get_contents( $path ) ) as $raw ) {
			$line = \trim( $raw );
			if ( '' === $line || '#' === $line[0] ) {
				continue;
			}
			if ( \preg_match( '/^make_node\s+(\S+)\s+(\S+)(?:\s+(\S+))?/', $line, $m ) ) {
				$kind = $kind_of( $m[1] );
				// Tokens 3.. are the positional args after the type + node name; carried so
				// a CI (e.g. Aggregator_CI) can discover a wired custom node's config.
				$tokens = \preg_split( '/\s+/', $line ) ?: [];
				$node   = [
					'name' => $m[2],
					'kind' => $kind,
					'type' => $m[1],
					'args' => \array_slice( $tokens, 3 ),
				];
				if ( ( 'partition' === $kind || 'topic' === $kind ) && isset( $m[3] ) ) {
					$node['writes'] = $basename( $m[3] );
				} elseif ( 'consumer' === $kind && isset( $m[3] ) ) {
					$node['reads'] = $basename( $m[3] );
					// Consumer args are `<source> <offsetlog>`; the offsetlog basename
					// (2nd positional, token 4) is the consumer's unique READER id —
					// disambiguates two topologies tailing the SAME source.
					if ( isset( $tokens[4] ) ) {
						$node['reader'] = $basename( $tokens[4] );
					}
				} elseif ( 'log' === $kind && isset( $m[3] ) ) {
					// make_node Log <name> <file> [segment_size] [num_segments].
					// Carry the raw path + sizes so dump_graph can stat the flat segments.
					$node['writes']       = $basename( $m[3] );
					$node['path']         = $m[3];
					$node['segment_size'] = isset( $tokens[4] ) && \ctype_digit( $tokens[4] ) ? (int) $tokens[4] : 0;
					$node['num_segments'] = isset( $tokens[5] ) && \ctype_digit( $tokens[5] ) ? (int) $tokens[5] : 0;
				}
				$nodes[] = $node;
				continue;
			}
			if ( \preg_match( '/^connect_node\s+(\S+)\s+(\S+)/', $line, $m ) ) {
				$edges[] = [ $m[1], $m[2] ];
				continue;
			}
			if ( \preg_match( '/^cmd\s+(\S+?):config\s+set_\w*target\s+(\S+)/', $line, $m ) ) {
				$edges[] = [ $m[1], $m[2] ];
			}
		}
		return self::$graph_cache[ $name ] = [
			'nodes' => $nodes,
			'edges' => $edges,
		];
	}

	/**
	 * Register a plugin's topologies: a node-namespace prefix + a stock dir.
	 *
	 * Topologies are NOT owned by the registering plugin. The catalog is built
	 * from `list()` (user dir ∪ every stock dir) by `publish_catalog`, and any
	 * active topology is spawned by `spawn_worker` regardless of which plugin — if
	 * any — shipped it. This call only makes a plugin's `*_Node` classes resolvable
	 * (`register_namespace`) and its `.tsl` files discoverable (`register_stock_dir`).
	 */
	public static function register_plugin( string $namespace_prefix, string $topologies_dir ): void {
		// Idempotent: repeated plugins_loaded passes must not re-register.
		$key = $namespace_prefix . '|' . \rtrim( $topologies_dir, '/' );
		if ( isset( self::$registered_plugins[ $key ] ) ) {
			return;
		}
		self::$registered_plugins[ $key ] = true;

		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( $namespace_prefix );
		self::register_stock_dir( $topologies_dir );
	}

	public static function register_stock_dir( string $path ): void {
		$path = \rtrim( $path, '/' );
		if ( '' === $path ) {
			return;
		}
		if ( ! \in_array( $path, self::$stock_dirs, true ) ) {
			\array_unshift( self::$stock_dirs, $path );
		}
	}

	/** @api Support for unit tests. */
	public static function reset(): void {
		self::$stock_dirs         = [];
		self::$user_dir           = '';
		self::$registered_plugins = [];
		self::reset_basename_cache();
	}

	/** Drop only the parsed caches, keeping the dir registrations (wired to Config::RESET_ACTION). */
	public static function reset_basename_cache(): void {
		self::$segment_size_overrides_cache = [];
		self::$write_set_cache              = [];
		self::$graph_cache                  = [];
		self::$frontmatter_cache            = [];
	}

	/**
	 * Register the substrate's own bundled dir as the lowest-priority fallback:
	 * appended to the END so every consumer-registered stock dir resolves first
	 * regardless of load-time ordering. Consumers override a builtin topology
	 * (e.g. hub-control) simply by shipping a same-named .tsl; nodes-only
	 * deployments still resolve via this fallback. Pushed once (idempotent).
	 */
	public static function register_builtin_dir( string $path ): void {
		$path = \rtrim( $path, '/' );
		if ( '' === $path || \in_array( $path, self::$stock_dirs, true ) ) {
			return;
		}
		self::$stock_dirs[] = $path;
	}

	public static function register_user_dir( string $path ): void {
		self::$user_dir = \rtrim( $path, '/' );
	}

	/** Read-only view of the user-dir path. */
	public static function user_dir(): string {
		return self::$user_dir;
	}

	/**
	 * Per-name source breakdown across user + stock dirs (powers the REST list `source` field).
	 *
	 * @return array<string,array{user:?string,stock:array<int,string>}>
	 */
	public static function describe(): array {
		$out = [];
		if ( '' !== self::$user_dir && \is_dir( self::$user_dir ) ) {
			foreach ( \glob( self::$user_dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$name                    = \basename( $path, '.tsl' );
				$out[ $name ]['user']    = $path;
				$out[ $name ]['stock'] ??= [];
			}
		}
		foreach ( self::$stock_dirs as $dir ) {
			foreach ( \glob( $dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$name                      = \basename( $path, '.tsl' );
				$out[ $name ]['user']    ??= null;
				$out[ $name ]['stock']   ??= [];
				$out[ $name ]['stock'][]   = $path;
			}
		}
		return $out;
	}

	/**
	 * One-line human summary of find_conflicts() output, shared by the admin
	 * sanitizer's settings error and the supervisor's refusal log so the two
	 * gates phrase a conflict identically. Empty input → empty string.
	 *
	 * @param array<array{a: string, b: string, shared: array<string>}> $conflicts
	 */
	public static function describe_conflicts( array $conflicts ): string {
		return \implode(
			', ',
			\array_map(
				static fn( array $c ): string => "{$c['a']} ↔ {$c['b']} ({$c['shared'][0]})",
				$conflicts
			)
		);
	}

	/**
	 * `newspack_nodes/spawn_worker` handler: spawn the {type, partition} worker iff
	 * it is in the active set (`Bootstrap::expand_workers()`) — ungated by plugin
	 * ownership. Fires `newspack_nodes/before_worker_spawn` (app runtime init)
	 * right before building the worker, then runs the `$spawn_runner` seam (which
	 * defaults to a real Worker_Base execution). A type with no active descriptor
	 * is a no-op. Registered once by the substrate (newspack-nodes.php).
	 */
	public static function spawn_worker( string $type, int $partition ): void {
		foreach ( \Newspack_Nodes\Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] !== $type || $w['partition'] !== $partition ) {
				continue;
			}
			$runner = self::$spawn_runner ?? static function ( string $t, int $p, string $topology_name, int $stale ): void {
				$base_dir   = \Newspack_Nodes\Bootstrap::base_dir();
				$supervisor = new \Newspack_Nodes\Supervisor( $base_dir, \NONCE_SALT );
				$wb         = new \Newspack_Nodes\Worker_Base( $base_dir, $t, $p, stale_timeout: $stale );
				$topology   = static function ( \Newspack_Nodes\Command_Interpreter_Node $interpreter, int $partition_arg ) use ( $topology_name ): void {
					\Newspack_Nodes\Topology_Loader::load( $topology_name, $partition_arg, $interpreter );
				};
				$wb->execute( $topology, \rest_url( 'newspack-nodes/v1/workers/spawn' ), $supervisor->generate_spawn_token( \time() ) );
			};
			// App runtime init (autoload, filters) before Topology_Loader::load parses the TSL — only when we actually spawn.
			\do_action( 'newspack_nodes/before_worker_spawn', $type, $partition );
			$w_topology = Core::as_string( $w['topology'] );
			$w_stale    = \is_scalar( $w['stale_timeout'] ) ? (int) $w['stale_timeout'] : 0;
			$runner( $w['type'], $w['partition'], $w_topology, $w_stale );
			break;
		}
	}
}
