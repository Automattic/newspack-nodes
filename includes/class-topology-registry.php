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

	/** @var array<string,array<string,string>> Memoized parsed `var` frontmatter by topology name; cleared by reset_basename_cache(). */
	private static array $frontmatter_cache = [];

	/** @var array<string,array{nodes:list<array<string,int|string|list<string>>>,edges:list<array{0:string,1:string}>}> Memoized structural graph by topology name (node entries carry `type` + `args`). */
	private static array $graph_cache = [];

	/** @var array<string,bool> Guards register_plugin against double-wiring (a second call would double-spawn). */
	private static array $registered_plugins = [];

	/** @var array<string,array<string,int>> Memoized per-Partition segment_size overrides by topology name. */
	private static array $segment_size_overrides_cache = [];

	/** @var array<string,array{statements:list<array{line:string,verb:string,values:list<string>,spans:list<string>,origin:?string,origins:list<string>,via:list<string>}>,tree:array<string,mixed>}> Memoized flattened statements by topology name; cleared by reset_basename_cache(). */
	private static array $statements_cache = [];

	/** @var array<int,string> Plugin-registered stock dirs (first wins). */
	private static array $stock_dirs = [];

	/** @var string Writable per-deployment user dir. */
	private static string $user_dir = '';

	/** @var array<string,array<string>> Memoized write-set by topology name; cleared by reset_basename_cache(). */
	private static array $write_set_cache = [];

	/**
	 * Per-topology `partition:` entry metadata for the sharing exemption:
	 * `entry => { sig: normalized make_node line, warranty: cap lifted }`.
	 *
	 * @var array<string, array<string, array{sig: string, warranty: bool}>>
	 */
	private static array $write_meta_cache = [];

	/**
	 * Add a topology to the persisted active set and spawn its fleet now.
	 *
	 * The shared activation primitive both the `topologies activate` CI verb and
	 * the `wp nodes activate` CLI verb call — the option-write + cache-invalidate
	 * + immediate spawn. Materializes the effective active set
	 * (Bootstrap::get_topologies(), NOT get_option default — so the config-file
	 * defaults aren't silently dropped), refuses a write-conflict BEFORE writing
	 * (so a conflicting set never gets persisted and spawned), then writes and
	 * spawns. Idempotent: an already-active name re-spawns without duplicating.
	 *
	 * Callers are responsible for name validation + capability gating; this throws
	 * RuntimeException on an unknown name or a write-conflict so both surfaces
	 * report a uniform error.
	 *
	 * @param string $name Topology name (already validated by the caller).
	 * @return array{name: string, active: true, spawned: int}
	 * @throws \RuntimeException When the name is unknown or activating it would
	 *                           put two fleets on one log/offsetlog.
	 */
	public static function activate( string $name ): array {
		if ( null === self::resolve( $name ) ) {
			throw new \RuntimeException(
				\esc_html( "unknown topology '$name'" )
			);
		}

		$next      = \array_values( \array_unique( \array_merge( \array_keys( \Newspack_Nodes\Bootstrap::get_topologies() ), [ $name ] ) ) );
		$conflicts = self::find_conflicts( $next );
		if ( ! empty( $conflicts ) ) {
			throw new \RuntimeException(
				\esc_html( "activating '$name' conflicts: " . self::describe_conflicts( $conflicts ) )
			);
		}

		\update_option( 'newspack_nodes_topologies', $next );
		self::invalidate_config_cache();

		$spawned = \Newspack_Nodes\Bootstrap::supervisor()->spawn_fleet( $name );

		return [
			'name'    => $name,
			'active'  => true,
			'spawned' => $spawned,
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
	 * Pairs of topologies in `$names` whose write-sets overlap — i.e. two worker
	 * processes that would write the same file (data log or cursor) and corrupt
	 * it. A partition BOTH declare with a byte-identical make_node line (the
	 * `include topic-probe` pattern) is a deliberately shared multi-writer log —
	 * atomic ≤PIPE_BUF appends + the rotate lock make that safe — and is NOT a
	 * conflict, unless either side lifts the write cap (`void_warranty` /
	 * `allow_large_writes`), which assumes a sole writer. Offsetlogs and
	 * deadletter dirs stay sole-writer: any overlap conflicts.
	 * Empty array = the set is safe to run together.
	 *
	 * @param array<string> $names
	 * @return array<array{a: string, b: string, shared: array<string>}>
	 */
	public static function find_conflicts( array $names ): array {
		$names = \array_values( \array_unique( $names ) );
		$sets  = [];
		$metas = [];
		foreach ( $names as $n ) {
			$sets[ $n ]  = self::write_set( $n );
			$metas[ $n ] = self::$write_meta_cache[ $n ] ?? [];
		}
		$conflicts = [];
		$count     = \count( $names );
		for ( $i = 0; $i < $count; $i++ ) {
			for ( $j = $i + 1; $j < $count; $j++ ) {
				$a      = $names[ $i ];
				$b      = $names[ $j ];
				$shared = [];
				foreach ( \array_intersect( $sets[ $a ], $sets[ $b ] ) as $entry ) {
					$ma = $metas[ $a ][ $entry ] ?? null;
					$mb = $metas[ $b ][ $entry ] ?? null;
					if (
						null !== $ma && null !== $mb
						&& '' !== $ma['sig'] && $ma['sig'] === $mb['sig']
						&& ! $ma['warranty'] && ! $mb['warranty']
					) {
						continue; // Identical shared declaration, cap intact.
					}
					$shared[] = $entry;
				}
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
	 * its Consumer offsetlog + deadletter paths (`make_node Consumer`'s 2nd and
	 * optional 3rd arg after the node name, in the flat layout). Paths are kept in
	 * raw token form (`<config:…>/<basename>.p<partition>`) — identical iff they
	 * resolve to the same file — and namespaced `partition:` / `offsetlog:` /
	 * `deadletter:` so the kinds can't false-match. A Consumer's SOURCE (1st arg
	 * after the node name) is a read, not a write, so it's excluded.
	 *
	 * @return array<string>
	 */
	public static function write_set( string $name ): array {
		if ( isset( self::$write_set_cache[ $name ] ) ) {
			return self::$write_set_cache[ $name ];
		}
		if ( null === self::resolve( $name ) ) {
			return self::$write_set_cache[ $name ] = [];
		}
		$seen  = [];
		$meta  = [];
		$nodes = [];
		foreach ( self::statements( $name )['statements'] as $statement ) {
			$verb   = $statement['verb'];
			// Fleet-scope the cursor; logs carry no token, so they collide.
			$values = \array_map(
				static fn ( string $v ): string => \str_replace( '<topology>', $name, $v ),
				$statement['values']
			);
			$class = $values[1] ?? '';
			// @longform Partition+Topic share `partition:` (same-log
			// collision). The full normalized line is the sharing signature:
			// identical across topologies = one deliberately shared decl.
			if ( 'make_node' === $verb && ( 'Partition' === $class || 'Topic' === $class ) ) {
				$node_name      = $values[2] ?? '';
				$entry          = 'partition:' . ( $values[3] ?? '' );
				$seen[ $entry ] = true;
				$meta[ $entry ] = [
					'sig'      => (string) \preg_replace( '/\s+/', ' ', \trim( \str_replace( '<topology>', $name, $statement['line'] ) ) ),
					'warranty' => $meta[ $entry ]['warranty'] ?? false,
				];
				$nodes[ $node_name ] = $entry;
				continue;
			}
			// A lifted write cap assumes a sole writer; mark the node's path.
			if ( 'cmd' === $verb && \str_ends_with( $values[1] ?? '', ':config' )
				&& \in_array( $values[2] ?? '', [ 'void_warranty', 'allow_large_writes' ], true ) ) {
				$node_name = \substr( $values[1], 0, -\strlen( ':config' ) );
				if ( isset( $nodes[ $node_name ] ) ) {
					$entry          = $nodes[ $node_name ];
					$meta[ $entry ] = [
						'sig'      => $meta[ $entry ]['sig'] ?? '',
						'warranty' => true,
					];
				}
				continue;
			}
			// offsetlog (4th value) + deadletter (5th): sole-writer logs.
			if ( 'make_node' === $verb && 'Consumer' === $class && isset( $values[4] ) ) {
				$seen[ 'offsetlog:' . $values[4] ] = true;
				if ( isset( $values[5] ) ) {
					$seen[ 'deadletter:' . $values[5] ] = true;
				}
			}
			// Remote_Source: <node> <vault> <source> [offsetlog] [dlq]
			if ( 'make_node' === $verb && 'Remote_Source' === $class ) {
				// The offsetlog is an ARG now; the derived path is a fallback.
				$offsetlog = $values[5] ?? ( '<config:offsets_dir>/' . ( $values[2] ?? '' ) . '.' . ( $values[4] ?? '' ) );
				$seen[ 'offsetlog:' . $offsetlog ] = true;
				if ( isset( $values[6] ) ) {
					$seen[ 'deadletter:' . $values[6] ] = true;
				}
			}
		}
		$out = \array_keys( $seen );
		\sort( $out );
		self::$write_meta_cache[ $name ] = $meta;
		return self::$write_set_cache[ $name ] = $out;
	}

	/**
	 * A topology's statements, includes flattened and verbs canonicalized.
	 *
	 * EVERY static reader goes through here. Scanning the raw file makes an
	 * include-only topology (ELN's combined.tsl is two `include` lines) look
	 * EMPTY — which silently disarmed the write_set conflict gate.
	 *
	 * THROWS on a broken include. The safety gates read through here: an empty
	 * write set reads as "no conflict" to find_conflicts and as "every one of its
	 * logs is an orphan" to Log_Cleaner. Fail loud; the display surfaces catch
	 * for themselves (graph_for internally; Log_Cleaner::declared_dirs and
	 * Workers_CI's override collector at their call sites) so one bad .tsl
	 * can't take out the dashboard or wp-admin.
	 *
	 * @return list<string>
	 * @throws \RuntimeException On an unknown include, a cycle, or a conflicting make_node.
	 */
	private static function flat_lines( string $name ): array {
		return \array_column( self::statements( $name )['statements'], 'line' );
	}

	/**
	 * Flatten a topology and everything it includes into one statement list.
	 *
	 * Mirrors the Shell's include rules statically: registry name resolution,
	 * `#pragma once` per resolved path, an ancestor-stack cycle guard, and
	 * make_node dedup-or-conflict. Statement ORDER is the eval order.
	 *
	 * @param string       $name           Top-level topology; '' walks a synthetic top level.
	 * @param list<string> $extra_includes Includes to walk as if declared by the top level.
	 *
	 * @return array{statements: list<array{line: string, verb: string, values: list<string>, spans: list<string>, origin: ?string, origins: list<string>, via: list<string>}>, tree: array<string, mixed>}
	 * @throws \RuntimeException On unknown include, cycle, or conflicting make_node.
	 */
	public static function statements( string $name, array $extra_includes = [] ): array {
		// Every static reader walks this tree; a re-walk re-reads every file.
		$memo_key = $name . "\0" . \implode( ' ', $extra_includes );
		if ( isset( self::$statements_cache[ $memo_key ] ) ) {
			return self::$statements_cache[ $memo_key ];
		}
		$state = [
			'statements' => [],
			'expanded'   => [],
			'subtrees'   => [],
			'defs'       => [],
		];
		/** @var array<string,mixed> $tree */
		$tree = [];
		if ( '' !== $name ) {
			$path = self::resolve( $name );
			if ( null === $path ) {
				throw new \RuntimeException( \esc_html( "unknown topology: $name" ) );
			}
			$tree = self::walk( $path, $name, null, [], [], $state );
		}
		foreach ( $extra_includes as $include ) {
			$path = self::resolve( $include );
			if ( null === $path ) {
				throw new \RuntimeException( \esc_html( "unknown topology in include: $include" ) );
			}
			$tree[ $include ] = self::walk( $path, $include, $include, [ $include ], [], $state );
		}
		$out = [
			'statements' => $state['statements'],
			'tree'       => $tree,
		];
		return self::$statements_cache[ $memo_key ] = $out;
	}

	/**
	 * Walk one resolved topology file, appending its statements to $state.
	 *
	 * @param string       $path   Resolved .tsl path.
	 * @param string       $name   Topology name (for errors + the tree).
	 * @param string|null  $origin Directly-declared include this file sits under; null = the top-level file's own lines.
	 * @param list<string> $via    Include path from the top level down to this file.
	 * @param list<string> $stack  Ancestor resolved paths — a repeat is a cycle.
	 * @param array{statements: list<array{line: string, verb: string, values: list<string>, spans: list<string>, origin: ?string, origins: list<string>, via: list<string>}>, expanded: array<string,list<int>>, subtrees: array<string,array<string,mixed>>, defs: array<string,array{type:string,args:string,index:int}>} $state Walker state, by reference.
	 * @param-out array{statements: list<array{line: string, verb: string, values: list<string>, spans: list<string>, origin: ?string, origins: list<string>, via: list<string>}>, expanded: array<string,list<int>>, subtrees: array<string,array<string,mixed>>, defs: array<string,array{type:string,args:string,index:int}>} $state
	 *
	 * @return array<string, mixed> This file's include subtree.
	 */
	private static function walk( string $path, string $name, ?string $origin, array $via, array $stack, array &$state ): array {
		if ( \in_array( $path, $stack, true ) ) {
			throw new \RuntimeException( \esc_html( 'topology include cycle: ' . \implode( ' -> ', [ ...$via, $name ] ) ) );
		}
		if ( isset( $state['expanded'][ $path ] ) ) {
			if ( null !== $origin ) {
				foreach ( $state['expanded'][ $path ] as $index ) {
					$statement = $state['statements'][ $index ];
					if ( ! \in_array( $origin, $statement['origins'], true ) ) {
						$state['statements'][ $index ] = [
							...$statement,
							'origins' => [ ...$statement['origins'], $origin ],
						];
					}
				}
			}
			return $state['subtrees'][ $path ];
		}
		$members = [];
		$stack[] = $path;
		$subtree = [];
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		foreach ( Shell_Node::parse_statements( (string) \file_get_contents( $path ) ) as $statement ) {
			$line   = $statement['raw'];
			$verb   = $statement['verb'];
			$values = $statement['values'];
			if ( 'include' === $verb ) {
				$child_name = $values[1] ?? '';
				$child_path = self::resolve( $child_name );
				if ( null === $child_path ) {
					throw new \RuntimeException( \esc_html( "unknown topology in include: $child_name" ) );
				}
				$child_origin = $origin ?? $child_name;
				// Memoized subtree: the tree shows what each file DECLARES.
				$subtree[ $child_name ] = self::walk(
					$child_path,
					$child_name,
					$child_origin,
					[ ...$via, $child_name ],
					$stack,
					$state
				);
				$members = [ ...$members, ...$state['expanded'][ $child_path ] ];
				continue;
			}
			// Only the TOP-LEVEL file's frontmatter is honored.
			if ( null !== $origin && 'var' === $verb ) {
				continue;
			}
			if ( 'make_node' === $verb ) {
				$node_name = $values[2] ?? '';
				$def       = [
					'type' => $values[1] ?? '',
					'args' => \implode( ' ', \array_slice( $statement['spans'], 3 ) ),
				];
				$prior     = $state['defs'][ $node_name ] ?? null;
				if ( null !== $prior ) {
					if ( $prior['type'] === $def['type'] && $prior['args'] === $def['args'] ) {
						$statement = $state['statements'][ $prior['index'] ];
						if ( null !== $origin && ! \in_array( $origin, $statement['origins'], true ) ) {
							$state['statements'][ $prior['index'] ] = [
								...$statement,
								'origins' => [ ...$statement['origins'], $origin ],
							];
						}
						$members[] = $prior['index'];
						continue;
					}
					throw new \RuntimeException(
						\esc_html( "make_node conflict: '$node_name' declared as {$prior['type']} '{$prior['args']}' and as {$def['type']} '{$def['args']}'" )
					);
				}
				$state['defs'][ $node_name ] = [
					...$def,
					'index' => \count( $state['statements'] ),
				];
			}
			$members[]             = \count( $state['statements'] );
			$state['statements'][] = [
				'line'    => $line,
				'verb'    => $statement['verb'],
				'values'  => $statement['values'],
				'spans'   => $statement['spans'],
				'origin'  => $origin,
				'origins' => null === $origin ? [] : [ $origin ],
				'via'     => $via,
			];
		}
		$state['expanded'][ $path ] = \array_values( \array_unique( $members ) );
		$state['subtrees'][ $path ] = $subtree;
		return $subtree;
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
	 * Drop the per-process option snapshot then the config snapshot so the next
	 * Bootstrap::get_topologies() / expand_workers() sees the just-written active
	 * set. Same pair, same order, as Supervisor::check_config(). Public so the
	 * Topologies_CI delete verb (which mutates the active set on its own path)
	 * shares this one definition instead of carrying a parallel copy.
	 */
	public static function invalidate_config_cache(): void {
		\Newspack_Nodes\Config::invalidate_options_cache();
		\Newspack_Nodes\Config::reset();
	}

	/**
	 * Compose an include set into one graph with provenance — for the console.
	 *
	 * Informational only: the runtime is the Shell's `include`. `origin` is the
	 * SET of directly-declared includes providing a node (a diamond lists several);
	 * `via` is the path it first entered through.
	 *
	 * @param list<string> $include_names Directly-declared includes.
	 *
	 * @return array{nodes: list<array{name: string, class: string, is_tee: bool, args: list<string>, origin: list<string>, via: list<string>}>, edges: list<array{from: string, to: string, origin: list<string>, roles: list<string>, config_slots?: list<string>}>, tree: array<string,mixed>, hulls: array<string,list<string>>}
	 * @throws \RuntimeException On unknown include, cycle, or conflicting make_node.
	 */
	public static function expand( array $include_names ): array {
		$nodes  = [];
		$edges  = [];
		$walked = self::statements( '', $include_names );
		foreach ( $walked['statements'] as $statement ) {
			self::absorb_statement( $statement, $statement['origins'], $nodes, $edges );
		}
		return [
			'nodes' => \array_values( $nodes ),
			'edges' => self::export_edges( $edges, $include_names ),
			'tree'  => $walked['tree'],
			'hulls' => self::hulls_for_tree( $walked['tree'] ),
		];
	}

	/**
	 * Fold one statement into the node/edge maps, unioning `origin` on a re-reach.
	 *
	 * @param array{line: string, verb: string, values: list<string>, spans: list<string>, origin: ?string, origins: list<string>, via: list<string>} $statement Walked statement.
	 * @param list<string>                                                            $origins   Top-level includes providing it.
	 * @param array<string, array{name: string, class: string, is_tee: bool, args: list<string>, verbs: list<array{verb: string, args: list<string>}>, origin: list<string>, via: list<string>}> $nodes Node map, by reference.
	 * @param array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}>      $edges Edge-state map, by reference.
	 */
	private static function absorb_statement( array $statement, array $origins, array &$nodes, array &$edges ): void {
		$verb   = $statement['verb'];
		$values = $statement['values'];
		$spans  = $statement['spans'];
		if ( 'make_node' === $verb ) {
			$name = $values[2] ?? '';
			if ( isset( $nodes[ $name ] ) ) {
				foreach ( $origins as $origin ) {
					if ( ! \in_array( $origin, $nodes[ $name ]['origin'], true ) ) {
						$nodes[ $name ]['origin'][] = $origin;
					}
				}
				return;
			}
			$class          = $values[1] ?? '';
			$nodes[ $name ] = [
				'name'   => $name,
				'class'  => $class,
				'is_tee' => self::type_is_tee( $class ),
				'args'   => \array_slice( $spans, 3 ),
				'verbs'  => [],
				'origin' => $origins,
				'via'    => $statement['via'],
			];
			return;
		}
		if ( 'disconnect_node' === $verb ) {
			$source = $values[1] ?? '';
			$is_tee = $nodes[ $source ]['is_tee'] ?? false;
			self::disconnect_edge( $edges, $source, $values[2] ?? null, $is_tee );
			return;
		}
		if ( 'connect_node' === $verb ) {
			$source = $values[1] ?? '';
			$is_tee = $nodes[ $source ]['is_tee'] ?? false;
			self::connect_edge( $edges, $source, $values[2] ?? '', $origins, $is_tee );
			return;
		}
		if ( 'cmd' === $verb ) {
			$target     = $values[1] ?? '';
			$has_config = \str_ends_with( $target, ':config' );
			$node_name  = $has_config ? \substr( $target, 0, -\strlen( ':config' ) ) : $target;
			$inner_verb = $values[2] ?? '';
			// `:config set_*target` is a routing EDGE, not a config verb.
			if ( $has_config && \preg_match( '/^set_\w*target$/', $inner_verb ) ) {
				$edge_target = Core::resolve_config_tokens( \implode( ' ', \array_slice( $values, 3 ) ) );
				self::set_config_edge( $edges, $node_name, $edge_target, $inner_verb, $origins );
				return;
			}
			// Every other verb rides on the node so the console can show it.
			if ( isset( $nodes[ $node_name ] ) ) {
				$nodes[ $node_name ]['verbs'][] = [
					'verb' => $inner_verb,
					'args' => \array_slice( $spans, 3 ),
				];
			}
		}
	}

	/**
	 * True when a TSL class token resolves to Tee fan-out semantics.
	 */
	private static function type_is_tee( string $type ): bool {
		if ( 'Tee' === $type ) {
			return true;
		}
		$fqcn = Command_Interpreter_Node::resolve_class( $type );
		return null !== $fqcn && \is_a( $fqcn, Tee_Node::class, true );
	}

	/**
	 * Mirror runtime disconnect: regular Nodes clear their connect target;
	 * Tees remove an explicit target, while an omitted target defaults to the
	 * Shell envelope FROM and therefore does not clear the topology's fan-out.
	 * Configuration-target roles are independent and never removed here.
	 *
	 * @param array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges Edge-state map, by reference.
	 * @param-out array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges
	 */
	private static function disconnect_edge( array &$edges, string $source, ?string $target, bool $is_tee ): void {
		if ( $is_tee && null === $target ) {
			return;
		}
		foreach ( \array_keys( $edges ) as $key ) {
			$edge = $edges[ $key ];
			if ( $edge['from'] !== $source || ( $is_tee && $edge['to'] !== $target ) ) {
				continue;
			}
			$remaining = self::without_connect_role( $edge );
			if ( null === $remaining ) {
				unset( $edges[ $key ] );
				continue;
			}
			$edges[ $key ] = $remaining;
		}
	}

	/**
	 * Remove the runtime connect role while preserving independent config roles.
	 *
	 * @param array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}} $edge Edge state.
	 * @return array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}|null
	 */
	private static function without_connect_role( array $edge ): ?array {
		if ( [] === $edge['origins']['config'] ) {
			return null;
		}
		return [
			'from'    => $edge['from'],
			'to'      => $edge['to'],
			'origins' => [
				'connect' => [],
				'config'  => $edge['origins']['config'],
			],
		];
	}

	/**
	 * Mirror Node::connect_node (replace) versus Tee_Node::connect_node (append).
	 *
	 * @param array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges Edge-state map, by reference.
	 * @param list<string> $origins Top-level includes providing the connection.
	 * @param-out array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges
	 */
	private static function connect_edge( array &$edges, string $source, string $target, array $origins, bool $is_tee ): void {
		if ( ! $is_tee ) {
			$current_key = $source . "\0" . $target;
			foreach ( \array_keys( $edges ) as $key ) {
				if ( $current_key === $key || $edges[ $key ]['from'] !== $source ) {
					continue;
				}
				$remaining = self::without_connect_role( $edges[ $key ] );
				if ( null === $remaining ) {
					unset( $edges[ $key ] );
					continue;
				}
				$edges[ $key ] = $remaining;
			}
		}
		self::add_connect_origins( $edges, $source, $target, $origins );
	}

	/**
	 * Add one connect relationship origin.
	 *
	 * @param array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges Edge-state map, by reference.
	 * @param list<string> $origins Top-level includes providing the connection.
	 * @param-out array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges
	 */
	private static function add_connect_origins( array &$edges, string $source, string $target, array $origins ): void {
		$key             = self::ensure_edge( $edges, $source, $target );
		$edge            = $edges[ $key ];
		$connect_origins = $edge['origins']['connect'];
		foreach ( $origins as $origin ) {
			if ( ! \in_array( $origin, $connect_origins, true ) ) {
				$connect_origins[] = $origin;
			}
		}
		$edges[ $key ] = [
			'from'    => $edge['from'],
			'to'      => $edge['to'],
			'origins' => [
				'connect' => $connect_origins,
				'config'  => $edge['origins']['config'],
			],
		];
	}

	/**
	 * Ensure one insertion-ordered edge-state record and return its key.
	 *
	 * @param array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges Edge-state map, by reference.
	 * @param-out array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges
	 */
	private static function ensure_edge( array &$edges, string $source, string $target ): string {
		$key = $source . "\0" . $target;
		if ( ! isset( $edges[ $key ] ) ) {
			$edges[ $key ] = [
				'from'    => $source,
				'to'      => $target,
				'origins' => [
					'connect' => [],
					'config'  => [],
				],
			];
		}
		return $key;
	}

	/**
	 * Replace one named config-target slot without disturbing other setters.
	 *
	 * @param array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges Edge-state map, by reference.
	 * @param list<string> $origins Top-level includes providing the configuration.
	 * @param-out array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges
	 */
	private static function set_config_edge( array &$edges, string $source, string $target, string $slot, array $origins ): void {
		$current_key = $source . "\0" . $target;
		foreach ( \array_keys( $edges ) as $key ) {
			if ( $current_key === $key || $edges[ $key ]['from'] !== $source ) {
				continue;
			}
			$edge   = $edges[ $key ];
			$config = $edge['origins']['config'];
			unset( $config[ $slot ] );
			if ( [] === $edge['origins']['connect'] && [] === $config ) {
				unset( $edges[ $key ] );
				continue;
			}
			$edges[ $key ] = [
				'from'    => $edge['from'],
				'to'      => $edge['to'],
				'origins' => [
					'connect' => $edge['origins']['connect'],
					'config'  => $config,
				],
			];
		}
		if ( '' === $target ) {
			return;
		}
		$key          = self::ensure_edge( $edges, $source, $target );
		$edge         = $edges[ $key ];
		$config       = $edge['origins']['config'];
		$slot_origins = $config[ $slot ] ?? [];
		foreach ( $origins as $origin ) {
			if ( ! \in_array( $origin, $slot_origins, true ) ) {
				$slot_origins[] = $origin;
			}
		}
		$config[ $slot ] = $slot_origins;
		$edges[ $key ]    = [
			'from'    => $edge['from'],
			'to'      => $edge['to'],
			'origins' => [
				'connect' => $edge['origins']['connect'],
				'config'  => $config,
			],
		];
	}

	/**
	 * Export active edge state for the topology-console baseline contract.
	 *
	 * @param array<string, array{from: string, to: string, origins: array{connect: list<string>, config: array<string,list<string>>}}> $edges Edge-state map.
	 * @param list<string> $origin_order Top-level include declaration order.
	 * @return list<array{from: string, to: string, origin: list<string>, roles: list<string>, config_slots?: list<string>}>
	 */
	private static function export_edges( array $edges, array $origin_order ): array {
		$out          = [];
		$origin_order = \array_values( \array_unique( $origin_order ) );
		foreach ( $edges as $edge ) {
			$roles          = [];
			$config_origins = [];
			if ( [] !== $edge['origins']['connect'] ) {
				$roles[] = 'connect';
			}
			if ( [] !== $edge['origins']['config'] ) {
				$roles[] = 'config';
				foreach ( $edge['origins']['config'] as $origins ) {
					$config_origins = [ ...$config_origins, ...$origins ];
				}
			}
			$active_origins = \array_unique( [ ...$edge['origins']['connect'], ...$config_origins ] );
			$exported       = [
				'from'   => $edge['from'],
				'to'     => $edge['to'],
				'origin' => \array_values( \array_filter( $origin_order, static fn ( string $origin ): bool => \in_array( $origin, $active_origins, true ) ) ),
				'roles'  => $roles,
			];
			if ( [] !== $edge['origins']['config'] ) {
				$exported['config_slots'] = \array_keys( $edge['origins']['config'] );
			}
			$out[] = $exported;
		}
		return $out;
	}

	/**
	 * Node set of EVERY topology in the tree, nested ones included.
	 *
	 * The canvas draws a hull per include at any depth, so it needs each one's
	 * membership. `origin` (top-level) and `via` (first path) can't answer it —
	 * a node two levels down belongs to both hulls. Depth-first, so the outer
	 * topology precedes what it brings; the canvas paints in that order and the
	 * nested hull lands on top of its parent.
	 *
	 * @param array<array-key,mixed> $tree Include tree from statements().
	 * @return array<string, list<string>> Topology name => node names it provides.
	 */
	private static function hulls_for_tree( array $tree ): array {
		$out = [];
		foreach ( $tree as $name => $subtree ) {
			$out[ (string) $name ] = self::declared_node_names( (string) $name );
			if ( \is_array( $subtree ) ) {
				foreach ( self::hulls_for_tree( $subtree ) as $child => $names ) {
					$out[ $child ] = $names;
				}
			}
		}
		return $out;
	}

	/**
	 * Every node a topology declares, its own includes flattened in.
	 *
	 * @return list<string>
	 */
	private static function declared_node_names( string $name ): array {
		$names = [];
		foreach ( self::statements( $name )['statements'] as $statement ) {
			if ( 'make_node' === $statement['verb'] ) {
				$names[ $statement['values'][2] ?? '' ] = true;
			}
		}
		return \array_keys( $names );
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
			// Explicit kind→root map; a new entry can't hit offsets.
			$root = match ( $kind ) {
				'partition' => $logs_root,
				'offsetlog' => $offsets_root,
				default     => '',
			};
			if ( '' === $root ) {
				continue;
			}
			for ( $p = 0; $p < $num_partitions; $p++ ) {
				$concrete = Core::resolve_partition_template( $token, $p, $name );
				$prefix   = $root . '/';
				if ( 0 !== \strpos( $concrete, $prefix ) ) {
					continue;
				}
				$first = \explode( '/', \substr( $concrete, \strlen( $prefix ) ) )[0];
				if ( '' === $first ) {
					continue;
				}
				// Keep FIRST partition seen (nested layout → one dir).
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
		$overrides = [];
		$shell     = new Shell_Node();
		foreach ( self::flat_lines( $name ) as $line ) {
			// @longform Layout-agnostic: VALUE tokens (quotes stripped, so a
			// deferred '<partition>' path reads uniformly), basename from the
			// path's last component whether the token is .p<partition> or a
			// pinned .p0, size from the 1st arg after the path, int-filtered.
			$values = $shell->tokenize( $line );
			if ( 'make_node' !== ( $values[0] ?? '' ) || 'Partition' !== ( $values[1] ?? '' ) ) {
				continue;
			}
			$path = $values[3] ?? '';
			$size = $values[4] ?? '';
			if ( ! \preg_match( '{/([A-Za-z0-9_-]+)\.p(?:<partition>|\d+)$}', $path, $m ) ) {
				continue;
			}
			if ( \ctype_digit( $size ) ) {
				$overrides[ $m[1] ] = (int) $size;
			}
		}
		return self::$segment_size_overrides_cache[ $name ] = $overrides;
	}

	/**
	 * Raw structural graph for `$name` from its TSL (+ every topology it
	 * `include`s, flattened via statements()): nodes with a class-derived kind,
	 * the make_node `type` token + positional `args` list, (+ the log a
	 * Partition/Topic writes or a Consumer reads, from the path/source ARG — never
	 * a name suffix), and edges from `connect_node` plus
	 * `cmd <node>:config set_*_target <target>`, with `disconnect_node` applied
	 * in evaluation order. Memoized.
	 *
	 * @return array{nodes: list<array<string,int|string|list<string>>>, edges: list<array{0:string,1:string}>}
	 */
	public static function graph_for( string $name ): array {
		if ( isset( self::$graph_cache[ $name ] ) ) {
			return self::$graph_cache[ $name ];
		}
		if ( null === self::resolve( $name ) ) {
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
			// An unknown Tee subclass (e.g. Tap) also gets 'tee'.
			if ( 'logic' === $kind && self::type_is_tee( $cls ) ) {
				return 'tee';
			}
			return $kind;
		};
		$basename = static function ( string $arg ): string {
			$slash = \strrpos( $arg, '/' );
			return false === $slash ? $arg : \substr( $arg, $slash + 1 );
		};
		$nodes = [];
		$types = [];
		$edges = [];
		try {
			$walked = self::statements( $name );
		} catch ( \RuntimeException $e ) {
			// Display helper: one broken include must not take out dump_graph.
			Core::print_less_often( 'graph_for ', $name, ': ' . $e->getMessage() );
			return self::$graph_cache[ $name ] = [
				'nodes' => [],
				'edges' => [],
			];
		}
		foreach ( $walked['statements'] as $statement ) {
			$verb   = $statement['verb'];
			$values = $statement['values'];
			$spans  = $statement['spans'];
			if ( 'make_node' === $verb ) {
				$class          = $values[1] ?? '';
				$node_name      = $values[2] ?? '';
				$kind           = $kind_of( $class );
				$types[ $node_name ] = $class;
				// Spans 3.. = positional args; a CI reads the node's config.
				$path   = $spans[3] ?? null;
				$node   = [
					'name' => $node_name,
					'kind' => $kind,
					'type' => $class,
					'args' => \array_slice( $spans, 3 ),
				];
				if ( ( 'partition' === $kind || 'topic' === $kind ) && null !== $path ) {
					$node['writes'] = $basename( $path );
				} elseif ( 'consumer' === $kind && null !== $path ) {
					$node['reads'] = $basename( $path );
					// span 4 = consumer's READER id; disambiguates source.
					if ( isset( $spans[4] ) ) {
						$node['reader'] = $basename( $spans[4] );
					}
				} elseif ( 'log' === $kind && null !== $path ) {
					// Carry raw path + sizes so dump_graph stats flat segments.
					$node['writes']       = $basename( $path );
					$node['path']         = $path;
					$node['segment_size'] = isset( $spans[4] ) && \ctype_digit( $spans[4] ) ? (int) $spans[4] : 0;
					// Count target = num_segments, span 6 of Log args.
					$node['max_segments'] = isset( $spans[6] ) && \ctype_digit( $spans[6] ) ? (int) $spans[6] : 0;
				}
				$nodes[] = $node;
				continue;
			}
			if ( 'disconnect_node' === $verb ) {
				$source = $values[1] ?? '';
				$is_tee = isset( $types[ $source ] ) && self::type_is_tee( $types[ $source ] );
				self::disconnect_edge( $edges, $source, $values[2] ?? null, $is_tee );
				continue;
			}
			if ( 'connect_node' === $verb ) {
				$source = $values[1] ?? '';
				$is_tee = isset( $types[ $source ] ) && self::type_is_tee( $types[ $source ] );
				self::connect_edge( $edges, $source, $values[2] ?? '', [ $name ], $is_tee );
				continue;
			}
			if ( 'cmd' === $verb && \str_ends_with( $values[1] ?? '', ':config' )
				&& \preg_match( '/^set_\w*target$/', $values[2] ?? '' ) ) {
				$node_name = \substr( $values[1], 0, -\strlen( ':config' ) );
				self::set_config_edge( $edges, $node_name, Core::resolve_config_tokens( $values[3] ?? '' ), $values[2], [ $name ] );
			}
		}
		return self::$graph_cache[ $name ] = [
			'nodes' => $nodes,
			'edges' => \array_map(
				static fn ( array $edge ): array => [ $edge['from'], $edge['to'] ],
				\array_values( $edges )
			),
		];
	}

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
		$cfg_np     = \Newspack_Nodes\Config::value( 'num_partitions' );
		$default_np = \max( 1, \min( 16, Core::as_int( $cfg_np, 1 ) ) );
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
		foreach ( Shell_Node::parse_statements( $contents ) as $statement ) {
			if ( 'var' !== $statement['verb'] ) {
				continue;
			}
			// Same first-`=` split Shell_Node::parse() applies to the var tail.
			$assignment = \implode( ' ', \array_slice( $statement['values'], 1 ) );
			$eq         = \strpos( $assignment, '=' );
			if ( false === $eq ) {
				continue;
			}
			$key = \trim( \substr( $assignment, 0, $eq ) );
			if ( '' === $key ) {
				continue;
			}
			$out[ $key ] = \trim( \substr( $assignment, $eq + 1 ) );
		}
		return self::$frontmatter_cache[ $name ] = $out;
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
		self::$write_meta_cache             = [];
		self::$graph_cache                  = [];
		self::$frontmatter_cache            = [];
		self::$statements_cache             = [];
	}

	/**
	 * Remove a topology from the persisted active set and drain its fleet now.
	 *
	 * Symmetric with activate(): the shared deactivation primitive both the
	 * `topologies deactivate` CI verb and the `wp nodes deactivate` CLI verb call.
	 * Removes the name from the effective active set, writes, invalidates the
	 * config cache, then drops a restart flag on every live worker lock dir via
	 * Supervisor::kill_readers(). Callers validate the name + gate the capability.
	 *
	 * @param string $name Topology name (already validated by the caller).
	 * @return array{name: string, active: false}
	 */
	public static function deactivate( string $name ): array {
		$active = \array_values( \array_diff( \array_keys( \Newspack_Nodes\Bootstrap::get_topologies() ), [ $name ] ) );
		\update_option( 'newspack_nodes_topologies', $active );
		self::invalidate_config_cache();

		\Newspack_Nodes\Bootstrap::supervisor()->kill_readers( [ $name ] );

		return [
			'name'   => $name,
			'active' => false,
		];
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
	 * Register the substrate's own bundled dir as the lowest-priority fallback:
	 * appended to the END so every consumer-registered stock dir resolves first
	 * regardless of load-time ordering. Consumers override a builtin topology
	 * (e.g. job-worker) simply by shipping a same-named .tsl; nodes-only
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
	 * `newspack_nodes/spawn_worker` handler: spawn the {type, partition} worker iff
	 * it is in the active set (`Bootstrap::expand_workers()`) — ungated by plugin
	 * ownership. Runs the `$spawn_runner` seam (which defaults to a real
	 * Worker_Base execution). A type with no active descriptor is a no-op.
	 * Registered once by the substrate (newspack-nodes.php).
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
			$w_topology = Core::as_string( $w['topology'] );
			$w_stale    = Core::as_int( $w['stale_timeout'] );
			$runner( $w['type'], $w['partition'], $w_topology, $w_stale );
			break;
		}
	}
}
