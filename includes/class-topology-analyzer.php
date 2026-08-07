<?php
/**
 * Topology_Analyzer: static analysis of the TSL a topology is written in.
 *
 * Reads `.tsl` sources and answers questions ABOUT them without running
 * anything: flatten the include tree (cycle guard, `#pragma once`, make_node
 * dedup-or-conflict), build the node/edge graph the console and dashboards
 * draw, derive the write set that `find_conflicts` and `Log_Cleaner` gate on,
 * and resolve the resource dirs a topology declares.
 *
 * Split out of `Topology_Registry`, whose docblock said "name -> .tsl path
 * resolver" while about sixty of its 1459 lines did that and the rest were
 * three other classes. Analysis sat in the same file as the code that forks
 * worker processes, so every change carried the whole dependency set —
 * `Bootstrap`, `Fleet_Node`, `Worker_Base`, `update_option()`, `rest_url()` —
 * and `activate()` lived 1200 lines from the `deactivate()` its docblock
 * cross-references.
 *
 * The dependency runs one way: the analyzer asks `Topology_Registry` where a
 * name's source lives, and never the reverse.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topology_Analyzer {

	/**
	 * What a Topic's `num_partitions` means when the argument is OMITTED —
	 * Topic_Node's schema default, not the worker count. Pinned to that schema
	 * by TopologyRegistryResolvedDirsTest so the two cannot drift.
	 */
	public const TOPIC_PARTITIONS_DEFAULT = '<config:num_partitions>';

	/** @var array<string,array<string,string>> Memoized parsed `var` frontmatter by topology name; cleared by reset_basename_cache(). */
	private static array $frontmatter_cache = [];

	/** @var array<string,array{nodes:list<array<string,int|string|list<string>>>,edges:list<array{0:string,1:string}>}> Memoized structural graph by topology name (node entries carry `type` + `args`). */
	private static array $graph_cache = [];

	/** @var array<string,array<string,int>> Memoized per-Partition segment_size overrides by topology name. */
	private static array $segment_size_overrides_cache = [];

	/** @var array<string,array{statements:list<array{line:string,verb:string,values:list<string>,spans:list<string>,origin:?string,origins:list<string>,via:list<string>}>,tree:array<string,mixed>}> Memoized flattened statements by topology name; cleared by reset_basename_cache(). */
	private static array $statements_cache = [];

	/** @var array<string,array<string>> Memoized write-set by topology name; cleared by reset_basename_cache(). */
	private static array $write_set_cache = [];

	/**
	 * Per-topology `partition:` entry metadata for the sharing exemption:
	 * `entry => { sig: normalized make_node line, warranty: cap lifted,
	 * partitions: a Topic's own declared count, raw }`.
	 *
	 * @var array<string, array<string, array{sig: string, warranty: bool, partitions: string}>>
	 */
	private static array $write_meta_cache = [];

	/**
	 * Per-topology `node name => write_set entry` for Partition/Topic nodes, so a
	 * caller can resolve ONE node's dirs without pattern-matching a path.
	 *
	 * @var array<string, array<string, string>>
	 */
	private static array $write_nodes_cache = [];

	/**
	 * Compose an include set into one graph with provenance — for the console.
	 *
	 * Informational only: the runtime is the Shell's `include`. `origin` is the
	 * SET of directly-declared includes providing a node (a diamond lists several);
	 * `via` is the path it first entered through.
	 *
	 * @param list<string> $include_names Directly-declared includes.
	 *
	 * @return array{nodes: list<array{name: string, class: string, fans_out: bool, args: list<string>, origin: list<string>, via: list<string>}>, edges: list<array{from: string, to: string, origin: list<string>, roles: list<string>, config_slots?: list<string>}>, tree: array<string,mixed>, hulls: array<string,list<string>>}
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
			$path = Topology_Registry::resolve( $name );
			if ( null === $path ) {
				throw new \RuntimeException( \esc_html( "unknown topology: $name" ) );
			}
			$tree = self::walk( $path, $name, null, [], [], $state );
		}
		foreach ( $extra_includes as $include ) {
			$path = Topology_Registry::resolve( $include );
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
				$child_path = Topology_Registry::resolve( $child_name );
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
	 * Fold one statement into the node/edge maps, unioning `origin` on a re-reach.
	 *
	 * @param array{line: string, verb: string, values: list<string>, spans: list<string>, origin: ?string, origins: list<string>, via: list<string>} $statement Walked statement.
	 * @param list<string>                                                            $origins   Top-level includes providing it.
	 * @param array<string, array{name: string, class: string, fans_out: bool, args: list<string>, verbs: list<array{verb: string, args: list<string>}>, origin: list<string>, via: list<string>}> $nodes Node map, by reference.
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
				'fans_out' => self::type_fans_out( $class ),
				'args'   => \array_slice( $spans, 3 ),
				'verbs'  => [],
				'origin' => $origins,
				'via'    => $statement['via'],
			];
			return;
		}
		if ( 'disconnect_node' === $verb ) {
			$source = $values[1] ?? '';
			$fans_out = $nodes[ $source ]['fans_out'] ?? false;
			self::disconnect_edge( $edges, $source, $values[2] ?? null, $fans_out );
			return;
		}
		if ( 'connect_node' === $verb ) {
			$source = $values[1] ?? '';
			$fans_out = $nodes[ $source ]['fans_out'] ?? false;
			self::connect_edge( $edges, $source, $values[2] ?? '', $origins, $fans_out );
			return;
		}
		if ( 'command_node' === $verb ) {
			$target     = $values[1] ?? '';
			$has_config = \str_ends_with( $target, ':config' );
			$node_name  = $has_config ? \substr( $target, 0, -\strlen( ':config' ) ) : $target;
			$inner_verb = $values[2] ?? '';
			// `:config set_*target` is a routing EDGE, not a config verb.
			if ( $has_config && \preg_match( '/^set_\w*target$/', $inner_verb ) ) {
				// One token: the runtime handler reads $args[0].
				$edge_target = Core::resolve_config_tokens( $values[3] ?? '' );
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
	 * True when a TSL class token resolves to a class that keeps a target LIST.
	 */
	private static function type_fans_out( string $type ): bool {
		if ( 'Tee' === $type ) {
			return true;
		}
		$fqcn = Command_Interpreter_Node::resolve_class( $type );
		return null !== $fqcn && Core::class_fans_out( $fqcn );
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
	private static function disconnect_edge( array &$edges, string $source, ?string $target, bool $fans_out ): void {
		if ( $fans_out && null === $target ) {
			return;
		}
		foreach ( \array_keys( $edges ) as $key ) {
			$edge = $edges[ $key ];
			if ( $edge['from'] !== $source || ( $fans_out && $edge['to'] !== $target ) ) {
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
	private static function connect_edge( array &$edges, string $source, string $target, array $origins, bool $fans_out ): void {
		if ( ! $fans_out ) {
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
	 * Raw source templates of every Consumer in `$topology`.
	 *
	 * The template, not a basename: a caller resolves it per partition through
	 * `Core::resolve_partition_template()`, which is the ONE place the
	 * `<partition>` token is substituted. Nothing here may assume the token sits
	 * in any particular position — a `.p<partition>` suffix is one layout among
	 * several, and matching on it is how a path that puts the token elsewhere
	 * silently stops resolving.
	 *
	 * @param string $topology Topology name.
	 * @return list<string>
	 */
	public static function consumer_sources( string $topology ): array {
		$out = [];
		foreach ( self::graph_for( $topology )['nodes'] as $node ) {
			if ( 'consumer' !== ( $node['kind'] ?? '' ) ) {
				continue;
			}
			$args   = $node['args'] ?? [];
			$source = \is_array( $args ) ? Core::as_string( $args[0] ?? '' ) : '';
			if ( '' !== $source ) {
				$out[] = $source;
			}
		}
		return $out;
	}

	/**
	 * Raw structural graph for `$name` from its TSL (+ every topology it
	 * `include`s, flattened via statements()): nodes with a class-derived kind,
	 * the make_node `type` token + positional `args` list, (+ the log a
	 * Partition/Topic writes or a Consumer reads, from the path/source ARG — never
	 * a name suffix), and edges from `connect_node` plus
	 * `command_node <node>:config set_*_target <target>`, with `disconnect_node` applied
	 * in evaluation order. Memoized.
	 *
	 * @return array{nodes: list<array<string,int|string|list<string>>>, edges: list<array{0:string,1:string}>}
	 */
	public static function graph_for( string $name ): array {
		if ( isset( self::$graph_cache[ $name ] ) ) {
			return self::$graph_cache[ $name ];
		}
		if ( null === Topology_Registry::resolve( $name ) ) {
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
			// Tee subclasses only: 'tee' is contracted out of the graph.
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
				$fans_out = isset( $types[ $source ] ) && self::type_fans_out( $types[ $source ] );
				self::disconnect_edge( $edges, $source, $values[2] ?? null, $fans_out );
				continue;
			}
			if ( 'connect_node' === $verb ) {
				$source = $values[1] ?? '';
				$fans_out = isset( $types[ $source ] ) && self::type_fans_out( $types[ $source ] );
				self::connect_edge( $edges, $source, $values[2] ?? '', [ $name ], $fans_out );
				continue;
			}
			if ( 'command_node' === $verb && \str_ends_with( $values[1] ?? '', ':config' )
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

	private static function type_is_tee( string $type ): bool {
		if ( 'Tee' === $type ) {
			return true;
		}
		$fqcn = Command_Interpreter_Node::resolve_class( $type );
		return null !== $fqcn && \is_a( $fqcn, Tee_Node::class, true );
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
		if ( null === Topology_Registry::resolve( $name ) ) {
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
			if ( 'make_node' === $verb && ( self::type_is( $class, Partition_Node::class ) || self::type_is( $class, Topic_Node::class ) ) ) {
				$node_name      = $values[2] ?? '';
				$entry          = 'partition:' . ( $values[3] ?? '' );
				$seen[ $entry ] = true;
				// @longform A Topic re-partitions on its OWN count, whatever
				// the worker count. Partition has no such argument — its
				// 4th value is segment_size.
				$declared_partitions = 'Topic' === $class
					? Core::as_string( $values[4] ?? self::TOPIC_PARTITIONS_DEFAULT )
					: '';
				$meta[ $entry ]      = [
					'sig'        => (string) \preg_replace( '/\s+/', ' ', \trim( \str_replace( '<topology>', $name, $statement['line'] ) ) ),
					'warranty'   => $meta[ $entry ]['warranty'] ?? false,
					'partitions' => $declared_partitions,
				];
				$nodes[ $node_name ] = $entry;
				continue;
			}
			// A lifted write cap assumes a sole writer; mark the node's path.
			if ( 'command_node' === $verb && \str_ends_with( $values[1] ?? '', ':config' )
				&& \in_array( $values[2] ?? '', [ 'void_warranty', 'allow_large_writes' ], true ) ) {
				$node_name = \substr( $values[1], 0, -\strlen( ':config' ) );
				if ( isset( $nodes[ $node_name ] ) ) {
					$entry          = $nodes[ $node_name ];
					$meta[ $entry ] = [
						'sig'        => Core::as_string( $meta[ $entry ]['sig'] ?? '' ),
						'warranty'   => true,
						// Preserve the count; this branch only lifts the cap.
						'partitions' => Core::as_string( $meta[ $entry ]['partitions'] ?? '' ),
					];
				}
				continue;
			}
			// offsetlog (4th value) + deadletter (5th): sole-writer logs.
			if ( 'make_node' === $verb && self::type_is( $class, Consumer_Node::class ) && isset( $values[4] ) ) {
				$seen[ 'offsetlog:' . $values[4] ] = true;
				if ( isset( $values[5] ) ) {
					$seen[ 'deadletter:' . $values[5] ] = true;
				}
			}
			// Remote_Source: <node> <vault> <source> [offsetlog] [dlq]
			if ( 'make_node' === $verb && self::type_is( $class, Remote_Source_Node::class ) ) {
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
		self::$write_meta_cache[ $name ]  = $meta;
		self::$write_nodes_cache[ $name ] = $nodes;
		return self::$write_set_cache[ $name ] = $out;
	}

	/**
	 * Whether a TSL class token resolves to $fqcn (or a subclass).
	 *
	 * The write set is a SAFETY gate — it feeds `find_conflicts` and
	 * `Log_Cleaner`'s declared-dir set — and it used to string-compare the raw
	 * token, while the layout code beside it resolved the token and asked the
	 * type system. A plugin subclassing Partition therefore wrote a real log
	 * that no conflict check saw and the GC did not know was declared.
	 *
	 * @param string $type TSL class token.
	 * @param string $fqcn Fully-qualified base class.
	 * @return bool True when the token is that class or a subclass.
	 */
	private static function type_is( string $type, string $fqcn ): bool {
		$resolved = Command_Interpreter_Node::resolve_class( $type );
		return null !== $resolved && \is_a( $resolved, $fqcn, true );
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
		// write_set() populates the meta cache; read it AFTER.
		$entries = self::write_set( $name );
		$meta    = self::$write_meta_cache[ $name ] ?? [];
		foreach ( $entries as $entry ) {
			[ $kind, $token ] = \explode( ':', $entry, 2 );
			// @longform A Topic's declared count wins: it re-partitions
			// above the worker count (aggregator fan-in) or below it
			// (deliberate narrowing). An unresolvable token falls back
			// rather than declaring nothing — the GC deletes undeclared.
			$declared = self::declared_partition_count( $meta[ $entry ]['partitions'] ?? '' );
			$count    = $declared > 0 ? $declared : $num_partitions;
			// Explicit kind→root map; a new entry can't hit offsets.
			$root = match ( $kind ) {
				'partition' => $logs_root,
				'offsetlog' => $offsets_root,
				default     => '',
			};
			if ( '' === $root ) {
				continue;
			}
			$produced = [];
			for ( $p = 0; $p < $count; $p++ ) {
				$concrete = Core::resolve_partition_template( $token, $p, $name );
				// @longform Distinct CONCRETE paths, before the root filter:
				// a nested layout collapses to one first-level dir while
				// still expanding, and a path outside the root produces
				// none. Neither is a failed expansion.
				$produced[ $concrete ] = true;
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
			// @longform Declared N but no partition token to expand: every
			// partition writes ONE dir. Silent data concentration.
			if ( $declared > 1 && \count( $produced ) < $declared ) {
				// @longform print_less_often keys on the FIRST argument, so
				// the token must be in it or a second bad Topic is swallowed.
				Core::print_less_often(
					'ERROR: ' . $name . ': dir_template cannot expand to num_partitions: ' . $token
				);
			}
		}
		return [
			'logs'    => $logs,
			'offsets' => $offsets,
		];
	}

	/**
	 * A Topic's declared partition count: a literal, or a `<config:…>` token
	 * resolved the same way the runtime resolves it. 0 means "not declared, or
	 * unresolvable" — the caller falls back to the worker count.
	 */
	private static function declared_partition_count( string $raw ): int {
		if ( '' === $raw ) {
			return 0;
		}
		$resolved = Core::resolve_config_tokens( $raw );
		if ( ! \is_numeric( $resolved ) || (int) $resolved <= 0 ) {
			return 0;
		}
		// @longform Bounded like Bootstrap::num_partitions_for and
		// Log_Cleaner: a typo'd count would otherwise loop that many times
		// per sweep and return a declared set that size.
		return \min( (int) $resolved, Spawn_Coordinator::MAX_PARTITIONS );
	}

	/**
	 * Concrete dirs the Partition/Topic node `$node` writes in `$topology`,
	 * indexed by partition — the per-node counterpart of resolved_resource_dirs,
	 * for a reader that wants ONE resource's paths rather than the GC's whole
	 * first-level set. Same rules: a Topic's declared count wins over
	 * `$num_partitions`, the token is substituted wherever it sits, and a
	 * template carrying no partition token collapses to one dir at index 0 —
	 * `alerts.p0` is pinned across every worker on purpose. `[]` when
	 * `$topology` declares no such node.
	 *
	 * `$num_partitions` is the caller's worker count; pass
	 * `Bootstrap::num_partitions_for($topology)`.
	 *
	 * @return array<int,string>
	 */
	public static function resolved_node_dirs( string $topology, string $node, int $num_partitions ): array {
		// write_set() populates both caches; read them AFTER.
		self::write_set( $topology );
		$entry = self::$write_nodes_cache[ $topology ][ $node ] ?? '';
		if ( '' === $entry ) {
			return [];
		}
		$meta     = self::$write_meta_cache[ $topology ][ $entry ] ?? [];
		$declared = self::declared_partition_count( Core::as_string( $meta['partitions'] ?? '' ) );
		$count    = $declared > 0 ? $declared : \max( 1, $num_partitions );
		$dirs     = [];
		[ , $template ] = \explode( ':', $entry, 2 );
		for ( $p = 0; $p < $count; $p++ ) {
			$concrete = Core::resolve_partition_template( $template, $p, $topology );
			// Tokenless (or nested) template: keep the FIRST partition seen.
			if ( \in_array( $concrete, $dirs, true ) ) {
				continue;
			}
			$dirs[ $p ] = $concrete;
		}
		return $dirs;
	}

	/** Whether `$topology` declares a node named `$node` — including nodes that write nothing. */
	public static function declares_node( string $topology, string $node ): bool {
		return \in_array( $node, self::declared_node_names( $topology ), true );
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
		$path = Topology_Registry::resolve( $name );
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
	 * Every topology `$name` pulls in, at any depth — itself excluded.
	 *
	 * "Does this deployment run X?" cannot be answered from the ACTIVE topology
	 * NAMES: a deployment routinely runs a stock topology through a locally-named
	 * wrapper, and the wrapper's name says nothing about what it composes.
	 *
	 * @api Consumer plugins ask this; the substrate itself has no caller.
	 *
	 * @param string $name Topology to inspect.
	 *
	 * @return list<string> Transitive include names; empty when `$name` is unknown.
	 */
	public static function includes( string $name ): array {
		if ( null === Topology_Registry::resolve( $name ) ) {
			return [];
		}
		/** @var array<array-key, mixed> $tree */
		$tree = self::statements( $name )['tree'];
		return self::flatten_tree( $tree );
	}

	/**
	 * @param array<array-key, mixed> $tree Include subtree.
	 * @return list<string> Every name in the subtree, depth-first.
	 */
	private static function flatten_tree( array $tree ): array {
		$out = [];
		foreach ( $tree as $child => $subtree ) {
			$out[] = (string) $child;
			if ( \is_array( $subtree ) ) {
				foreach ( self::flatten_tree( $subtree ) as $deeper ) {
					$out[] = $deeper;
				}
			}
		}
		return \array_values( \array_unique( $out ) );
	}

	/** Drop every parsed cache; the source dirs are Topology_Registry's. */
	public static function reset_caches(): void {
		self::$segment_size_overrides_cache = [];
		self::$write_set_cache              = [];
		self::$write_meta_cache             = [];
		self::$write_nodes_cache            = [];
		self::$graph_cache                  = [];
		self::$frontmatter_cache            = [];
		self::$statements_cache             = [];
	}

	/**
	 * One-line human summary of find_conflicts() output, shared by the admin
	 * sanitizer's settings error and the spawner's refusal log so the two
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
	 * Lightweight `var name = value` extractor for fleet metadata reads (no topology execution).
	 *
	 * @return array<string,string>
	 */
	public static function frontmatter( string $name ): array {
		if ( isset( self::$frontmatter_cache[ $name ] ) ) {
			return self::$frontmatter_cache[ $name ];
		}
		$path = Topology_Registry::resolve( $name );
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
}
