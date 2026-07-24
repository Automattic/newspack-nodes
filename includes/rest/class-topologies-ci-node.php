<?php
/**
 * Topologies_CI: command-dispatch for substrate topology-management verbs.
 *
 * Topologies are .tsl files describing the node graph. User copies at
 * `{user_dir}/{name}.tsl` shadow plugin-shipped stock copies; this interpreter honors
 * that resolution order and only mutates the (writable) user dir.
 *
 * Verbs:
 *   list   — `{topologies: [{name, source, active, num_partitions, frontmatter}], user_dir}`.
 *            `source` is 'user'|'stock'|'both'; `active` follows the operator overlay;
 *            `num_partitions` is the canonical count (Bootstrap::num_partitions_for).
 *   get    — args `{name}`. Returns `{name, source, tsl, includes, expanded,
 *            resolved_config_edges}`; throws on miss. `expanded` contains only
 *            borrowed include members, while `resolved_config_edges` carries
 *            the whole topology's token-resolved config routing for the seed.
 *   save   — args `{name, tsl}`. Returns `{name, path, shadows_stock,
 *            restarted_fleets}`. 1 MiB cap; dry-run validation via
 *            Shell::validate_line, plus include resolution (Topology_Registry::expand
 *            rejects an unknown include, a cycle, or a make_node the body and an
 *            include declare differently — all of which would otherwise save clean
 *            and kill the worker at its next spawn); restarts the matching active fleet.
 *   expand — args `{names…}`. Returns `{nodes, edges, tree}` for an include SET:
 *            the composed graph with provenance (`origin` = the directly-declared
 *            includes providing a node, a LIST since a diamond-shared node has
 *            several; `via` = the path it entered through). Informational — the
 *            runtime is the Shell's `include`. The console's edit-mode baseline.
 *   delete — args `{name}`. Returns `{name, deleted, stock_fallback,
 *            pruned_active, restarted_fleets}`. User copy only (stock immutable);
 *            restarts the matching active fleet (symmetry with save). When no
 *            stock fallback remains, prunes the now-orphaned name from the active
 *            set (`newspack_nodes_topologies`); `pruned_active` reports whether it
 *            was present and removed.
 *   activate   — args `{name}`. Adds the name to the persisted active set
 *                (`newspack_nodes_topologies` option), invalidates the config
 *                cache, and spawns the fleet immediately. Returns the live array
 *                `{name, active:true, spawned:<int>}` (the command protocol
 *                carries VALUE as a live array, never separately JSON-encoded);
 *                throws RuntimeException (→ TM_ERROR) on unknown name, matching
 *                get/save/delete.
 *   deactivate — args `{name}`. Removes the name from the active set, invalidates
 *                the config cache, and drains the fleet immediately. Returns
 *                `{name, active:false}`.
 *
 * Verb-level auth is capability-only (manage_options); errors throw
 * RuntimeException, which CommandInterpreter::interpret() wraps as TM_ERROR.
 * Shared helpers come from Service_CI.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Topology_Registry;

\defined( 'ABSPATH' ) || exit;

class Topologies_CI_Node extends Service_CI_Node {

	private const MAX_BODY_BYTES = 1048576;
	/**
	 * `list` verb handler — registered topologies + active state.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_list(): array {
		// Active = what the supervisor would spawn (catalog + overlay).
		$resolved = Bootstrap::get_topologies();
		$active   = [];
		foreach ( $resolved as $name => $_def ) {
			if ( '' !== $name ) {
				$active[ $name ] = true;
			}
		}

		$out = [];
		foreach ( Topology_Registry::describe() as $name => $sources ) {
			$out[] = [
				'name'           => $name,
				'source'         => self::source_of( $sources ),
				'active'         => isset( $active[ $name ] ),
				'num_partitions' => Bootstrap::num_partitions_for( $name ),
				'frontmatter'    => Topology_Registry::frontmatter( $name ),
				'includes'       => self::direct_includes( $name ),
			];
		}
		\usort( $out, static fn ( $a, $b ) => $a['name'] <=> $b['name'] );

		return [
			'topologies' => $out,
			'user_dir'   => Topology_Registry::user_dir(),
		];
	}

	/**
	 * `get` verb handler — one topology's TSL + metadata by name.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_get( array $args ): array {
		$name = self::require_valid_name( $args[0] ?? '' );

		$path = Topology_Registry::resolve( $name );
		if ( null === $path ) {
			throw new \RuntimeException(
				\esc_html( "no topology named: $name" )
			);
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_get_contents,WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown -- Path is always a local .tsl file resolved via Topology_Registry; never a URL.
		$tsl = @\file_get_contents( $path );
		if ( false === $tsl ) {
			throw new \RuntimeException(
				\esc_html( "failed to read topology file: $path" )
			);
		}
		$sources = Topology_Registry::describe()[ $name ] ?? [
			'user'  => null,
			'stock' => [],
		];

		// Composed graph rides along: the console seeds its canvas from this.
		$includes              = self::direct_includes_from_tsl( $tsl );
		$resolved_config_edges = \array_values(
			\array_filter(
				Topology_Registry::expand( [ $name ] )['edges'],
				static fn ( array $edge ): bool => \in_array( 'config', $edge['roles'], true )
			)
		);

		return [
			'name'                  => $name,
			'source'                => self::source_of( $sources ),
			'tsl'                   => $tsl,
			'includes'              => $includes,
			'expanded'              => Topology_Registry::expand( $includes ),
			'resolved_config_edges' => $resolved_config_edges,
		];
	}

	/**
	 * A topology's DIRECT `include` lines, in declaration order.
	 *
	 * @return list<string>
	 */
	private static function direct_includes( string $name ): array {
		$path = Topology_Registry::resolve( $name );
		if ( null === $path ) {
			return [];
		}
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		return self::direct_includes_from_tsl( (string) \file_get_contents( $path ) );
	}

	/**
	 * Reduce a Topology_Registry::describe() entry to its 'user'|'stock'|'both'
	 * label (shared by list+get so the source flag stays consistent).
	 *
	 * @param array{user:?string,stock:array<int,string>} $sources describe() entry.
	 */
	private static function source_of( array $sources ): string {
		$has_user  = null !== ( $sources['user'] ?? null );
		$has_stock = ! empty( $sources['stock'] );
		if ( $has_user && $has_stock ) {
			return 'both';
		}
		return $has_user ? 'user' : 'stock';
	}

	/**
	 * `save` verb handler — persist a topology's TSL (size-guarded).
	 *
	 * @param list<string> $args Verb argument.
	 * @param array<int|string, mixed> $envelope Verb argument.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_save( array $args, array $envelope = [] ): array {
		// $envelope is the 7-field positional message array (a list).
		if ( \array_is_list( $envelope ) && Message::packed_size( $envelope ) > self::MAX_BODY_BYTES ) {
			throw new \RuntimeException(
				\esc_html( 'body too large: topology arguments exceed 1 MiB' )
			);
		}
		// `save <name> <tsl>`: name is first token, rest-of-line is the body.
		[ $name_raw, $tsl ] = self::split_first_token( $args );
		$name = self::require_valid_name( $name_raw );
		if ( '' === $tsl ) {
			throw new \RuntimeException( 'invalid arguments: tsl (topology body) is required' );
		}

		// Dry-run validation; report the 1-based offending line for the editor.
		$shell = new Shell_Node();
		foreach ( $shell->split_statements( $tsl ) as $i => $stmt ) {
			try {
				$shell->validate_line( $stmt );
			} catch ( \RuntimeException $e ) {
				// validate_line throws a fixed error; no escaping needed.
				$line_no = $i + 1;
				$message     = $e->getMessage();
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- $line_no is int; $message is a fixed Shell::validate_line string.
				throw new \RuntimeException( "validation failed at line $line_no: $message" );
			}
		}

		// Resolve includes too; a bad one must not save clean and die at boot.
		try {
			$borrowed = Topology_Registry::expand( self::direct_includes_from_tsl( $tsl ) );
			self::assert_no_borrowed_node_conflict( $tsl, $borrowed['nodes'] );
		} catch ( \RuntimeException $e ) {
			// Topology_Registry::expand already esc_html's its thrown messages.
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
			throw new \RuntimeException( "validation failed: {$e->getMessage()}" );
		}

		$user_dir = Topology_Registry::user_dir();
		if ( '' === $user_dir ) {
			throw new \RuntimeException(
				'Topology_Registry has no writable user dir'
			);
		}
		if ( ! \is_dir( $user_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			$made = @\mkdir( $user_dir, 0700, true );
			if ( ! $made && ! \is_dir( $user_dir ) ) {
				throw new \RuntimeException(
					\esc_html( "failed to create user dir: $user_dir" )
				);
			}
		}

		// shadows_stock determined BEFORE writing (pre-existing stock state).
		$pre_sources = Topology_Registry::describe()[ $name ] ?? [ 'stock' => [] ];
		$shadows     = ! empty( $pre_sources['stock'] );

		$path = $user_dir . '/' . $name . '.tsl';
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		$bytes = @\file_put_contents( $path, $tsl );
		if ( false === $bytes ) {
			throw new \RuntimeException(
				\esc_html( "failed to write topology file: $path" )
			);
		}

		// The file changed under the memoized readers.
		Topology_Registry::reset_basename_cache();

		// Restart the active fleet, keyed off the catalog filter (not overlay).
		$resolved  = \function_exists( 'apply_filters' )
			? (array) \apply_filters( 'newspack_nodes/topologies', [] )
			: [];
		$restarted = [];
		if ( isset( $resolved[ $name ] ) ) {
			\do_action( 'newspack_nodes/restart_fleet', $name );
			$restarted[] = $name;
		}

		return [
			'name'             => $name,
			'path'             => $path,
			'shadows_stock'    => $shadows,
			'restarted_fleets' => $restarted,
		];
	}

	/**
	 * `include` lines parsed straight out of a TSL body string — used by save's
	 * dry-run validation, where the body isn't on disk yet.
	 *
	 * @return list<string>
	 */
	private static function direct_includes_from_tsl( string $tsl ): array {
		$out = [];
		foreach ( Shell_Node::parse_statements( $tsl ) as $statement ) {
			if ( 'include' === $statement['verb'] && '' !== ( $statement['values'][1] ?? '' ) ) {
				$out[] = $statement['values'][1];
			}
		}
		return $out;
	}

	/**
	 * Throw if the saved body redeclares a borrowed node differently.
	 *
	 * `make_node` collapses an IDENTICAL redeclaration and throws on a
	 * conflicting one, so a body whose own `make_node` clashes with a node an
	 * `include` provides would save clean here and kill the worker at its next
	 * spawn. Catch it at the boundary instead.
	 *
	 * @param string                                                                                          $tsl            The body being saved.
	 * @param list<array{name: string, class: string, args: list<string>, origin: list<string>, via: list<string>}> $borrowed_nodes expand()'s node records.
	 * @throws \RuntimeException On a conflicting redeclaration.
	 */
	private static function assert_no_borrowed_node_conflict( string $tsl, array $borrowed_nodes ): void {
		$borrowed = [];
		foreach ( $borrowed_nodes as $node ) {
			$borrowed[ $node['name'] ] = [
				'class' => $node['class'],
				'args'  => \implode( ' ', $node['args'] ),
			];
		}
		foreach ( Shell_Node::parse_statements( $tsl ) as $statement ) {
			if ( 'make_node' !== $statement['verb'] ) {
				continue;
			}
			$node_name = $statement['values'][2] ?? '';
			$prior     = $borrowed[ $node_name ] ?? null;
			if ( null === $prior ) {
				continue;
			}
			$class = $statement['values'][1] ?? '';
			$args  = \implode( ' ', \array_slice( $statement['spans'], 3 ) );
			if ( $prior['class'] === $class && $prior['args'] === $args ) {
				continue;
			}
			throw new \RuntimeException(
				\esc_html( "make_node conflict: '{$node_name}' is provided by an include as {$prior['class']} '{$prior['args']}', redeclared as {$class} '{$args}'" )
			);
		}
	}

	/**
	 * `expand` verb handler — compose an include set for the console.
	 *
	 * @param list<string> $args Space-separated topology names.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_expand( array $args ): array {
		$names = $args;
		$names = \array_values( \array_filter( $names, fn ( $n ) => '' !== $n ) );
		foreach ( $names as $name ) {
			self::require_valid_name( $name );
		}
		return Topology_Registry::expand( $names );
	}

	/**
	 * `delete` verb handler — remove a user topology by name.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_delete( array $args ): array {
		$name = self::require_valid_name( $args[0] ?? '' );

		$user_dir = Topology_Registry::user_dir();
		if ( '' === $user_dir ) {
			throw new \RuntimeException(
				'Topology_Registry has no user dir configured'
			);
		}
		$path = $user_dir . '/' . $name . '.tsl';
		if ( ! \is_file( $path ) ) {
			throw new \RuntimeException(
				\esc_html( "no user-saved topology named: $name (stock copies are protected)" )
			);
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink,WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		if ( ! @\unlink( $path ) ) {
			throw new \RuntimeException(
				\esc_html( "failed to unlink topology file: $path" )
			);
		}
		// After unlink, resolve() returns the stock copy iff one exists.
		$has_stock_fallback = null !== Topology_Registry::resolve( $name );

		// No stock fallback → prune the name from the active set.
		$pruned = false;
		if ( ! $has_stock_fallback ) {
			$active = \array_values( \array_filter( (array) \get_option( 'newspack_nodes_topologies', [] ), '\is_string' ) );
			$pruned = \in_array( $name, $active, true );
			if ( $pruned ) {
				\update_option( 'newspack_nodes_topologies', \array_values( \array_diff( $active, [ $name ] ) ) );
				Topology_Registry::invalidate_config_cache();
			}
		}

		// Restart the active fleet (symmetry with save), keyed off the catalog.
		$resolved  = \function_exists( 'apply_filters' )
			? (array) \apply_filters( 'newspack_nodes/topologies', [] )
			: [];
		$restarted = [];
		if ( isset( $resolved[ $name ] ) ) {
			\do_action( 'newspack_nodes/restart_fleet', $name );
			$restarted[] = $name;
		}

		return [
			'name'             => $name,
			'deleted'          => $path,
			'stock_fallback'   => $has_stock_fallback,
			'pruned_active'    => $pruned,
			'restarted_fleets' => $restarted,
		];
	}

	/**
	 * `activate` verb handler — activate a topology by name.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_activate( array $args ): array {
		// Name-validate here; rest is shared Topology_Registry::activate.
		return Topology_Registry::activate( self::require_valid_name( $args[0] ?? '' ) );
	}

	/**
	 * `deactivate` verb handler — deactivate a topology by name.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return array<int|string, mixed>
	 */
	public static function cmd_deactivate( array $args ): array {
		return Topology_Registry::deactivate( self::require_valid_name( $args[0] ?? '' ) );
	}

	/**
	 * `connect_worker_input` verb handler — wire a worker input edge.
	 *
	 * @param list<string> $args Verb argument.
	 *
	 * @return string
	 */
	public static function cmd_connect_worker_input( array $args ): string {
		// Mount the worker's input Partition into this request's graph.
		Bootstrap::register_worker_partition( $args[0] ?? '', Bootstrap::base_dir() );
		return '';
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Topology (.tsl) management: list / get / save / delete user topology files, activate / deactivate topologies (immediate spawn / drain), and mount a worker input partition.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list',
					'description' => 'List topologies with source (user/stock/both) and active state.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_list(),
				],
				[
					'name'        => 'get',
					'description' => 'Read a topology .tsl by name.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_get( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'save',
					'description' => 'Write a user topology: `save <name> <tsl…>` (validated; restarts the active fleet). 1 MiB cap.',
					'args'        => [
						[ 'name' => 'name', 'type' => 'string', 'required' => true ],
						[ 'name' => 'tsl', 'type' => 'text', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_save( self::arg_strings( $args ), $envelope ),
				],
				[
					'name'        => 'delete',
					'description' => 'Delete a user topology (stock copies are protected).',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_delete( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'activate',
					'description' => 'Activate a topology: add it to the active set, persist, and spawn its fleet now.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_activate( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'deactivate',
					'description' => 'Deactivate a topology: remove it from the active set, persist, and drain its fleet now.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_deactivate( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'expand',
					'description' => 'Compose an include set into one graph with provenance (informational).',
					'args'        => [ [ 'name' => 'names', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_expand( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'connect_worker_input',
					'description' => "Mount the named worker's input partition into this request's graph.",
					'args'        => [ [ 'name' => 'reader', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_connect_worker_input( self::arg_strings( $args ) ),
				],
			],
		] );
	}

}
