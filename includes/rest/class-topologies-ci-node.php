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
 *   get    — args `{name}`. Returns `{name, source, tsl}`; throws on miss.
 *   save   — args `{name, tsl}`. Returns `{name, path, shadows_stock,
 *            restarted_fleets}`. 1 MiB cap; dry-run validation via
 *            Shell::validate_line; restarts the matching active fleet.
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
use Newspack_Nodes\Config;
use Newspack_Nodes\Message;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Topology_Registry;

\defined( 'ABSPATH' ) || exit;

class Topologies_CI_Node extends Service_CI_Node {
	private const MAX_BODY_BYTES = 1048576;

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
	 * Drop the per-process option snapshot then the config snapshot so the next
	 * Bootstrap::get_topologies() / expand_workers() sees the just-written active
	 * set. Same pair, same order, as Supervisor::check_config().
	 */
	private static function invalidate_config_cache(): void {
		Config::invalidate_options_cache();
		Config::reset();
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Topology (.tsl) management: list / get / save / delete user topology files, activate / deactivate topologies (immediate spawn / drain), and mount a worker input partition.',
			'arguments'        => [],
			'commands'       => [
				[
					'name'        => 'list',
					'description' => 'List topologies with source (user/stock/both) and active state.',
					'args'        => [],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
						// Active = whatever the supervisor would spawn (merged catalog + operator overlay).
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
							];
						}
						\usort( $out, static fn ( $a, $b ) => $a['name'] <=> $b['name'] );

						return [
							'topologies' => $out,
							'user_dir'   => Topology_Registry::user_dir(),
						];
					},
				],
				[
					'name'        => 'get',
					'description' => 'Read a topology .tsl by name.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args ): array {
						$name = self::require_valid_name( \trim( $args ) );

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

						return [
							'name'   => $name,
							'source' => self::source_of( $sources ),
							'tsl'    => $tsl,
						];
					},
				],
				[
					'name'        => 'save',
					'description' => 'Write a user topology: `save <name> <tsl…>` (validated; restarts the active fleet). 1 MiB cap.',
					'args'        => [
						[ 'name' => 'name', 'type' => 'string', 'required' => true ],
						[ 'name' => 'tsl', 'type' => 'text', 'required' => true ],
					],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array {
						self::require_manage_options();
						// $envelope is the 7-field positional message array (a list).
						if ( \array_is_list( $envelope ) && Message::packed_size( $envelope ) > self::MAX_BODY_BYTES ) {
							throw new \RuntimeException(
								\esc_html( 'body too large: topology arguments exceed 1 MiB' )
							);
						}
						// `save <name> <tsl…>`: name is the first token, the rest-of-line (may contain newlines) is the .tsl body.
						[ $name_raw, $tsl ] = self::split_first_token( $args );
						$name = self::require_valid_name( $name_raw );
						if ( '' === $tsl ) {
							throw new \RuntimeException( 'invalid arguments: tsl (topology body) is required' );
						}

						// Dry-run validation: each statement passes Shell's syntax check.
						// Report the 1-based offending line so the editor can position its cursor.
						$shell = new Shell_Node();
						foreach ( $shell->split_statements( $tsl ) as $i => $stmt ) {
							try {
								$shell->validate_line( $stmt );
							} catch ( \RuntimeException $e ) {
								// validate_line throws only a fixed-string structural error
								// (unterminated backslash continuation) — no user text, so no
								// escaping needed.
								$line_no = $i + 1;
								$msg     = $e->getMessage();
								// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- $line_no is int; $msg is a fixed Shell::validate_line string.
								throw new \RuntimeException( "validation failed at line $line_no: $msg" );
							}
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

						// shadows_stock determined BEFORE writing so it reflects pre-existing stock state.
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

						// Restart any active fleet running this topology, keyed off the raw
						// catalog filter (what might be running) not the operator overlay.
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
					},
				],
				[
					'name'        => 'delete',
					'description' => 'Delete a user topology (stock copies are protected).',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args ): array {
						self::require_manage_options();
						$name = self::require_valid_name( \trim( $args ) );

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
						// After unlink, resolve() returns the stock copy iff one exists — the fallback signal.
						$has_stock_fallback = null !== Topology_Registry::resolve( $name );

						// No stock fallback means the name no longer resolves to any
						// topology — prune it from the active set so the supervisor
						// stops trying to spawn a fleet that has nothing to load.
						$pruned = false;
						if ( ! $has_stock_fallback ) {
							$active = \array_values( \array_filter( (array) \get_option( 'newspack_nodes_topologies', [] ), '\is_string' ) );
							$pruned = \in_array( $name, $active, true );
							if ( $pruned ) {
								\update_option( 'newspack_nodes_topologies', \array_values( \array_diff( $active, [ $name ] ) ) );
								self::invalidate_config_cache();
							}
						}

						// Restart any active fleet running this topology (symmetry with save)
						// so the worker reloads the stock copy now shadowed-no-more — keyed
						// off the catalog filter (what might be running), evaluated AFTER the
						// unlink so a now-orphaned user-only name doesn't spuriously restart.
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
					},
				],
				[
					'name'        => 'activate',
					'description' => 'Activate a topology: add it to the active set, persist, and spawn its fleet now.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args ): array {
						self::require_manage_options();
						$name = \trim( $args );
						if ( '' === $name || null === Topology_Registry::resolve( $name ) ) {
							throw new \RuntimeException(
								\esc_html( "unknown topology '$name'" )
							);
						}

						// Materialize the effective active set + the name, then refuse a
						// write-conflict (two topologies writing the same log/offsetlog)
						// BEFORE persisting or spawning — so a conflicting set never gets
						// written and immediately spawned. Mirrors check_config's refusal.
						$next      = \array_values( \array_unique( \array_merge( \array_keys( Bootstrap::get_topologies() ), [ $name ] ) ) );
						$conflicts = Topology_Registry::find_conflicts( $next );
						if ( ! empty( $conflicts ) ) {
							throw new \RuntimeException(
								\esc_html( "activating '$name' conflicts: " . Topology_Registry::describe_conflicts( $conflicts ) )
							);
						}

						\update_option( 'newspack_nodes_topologies', $next );
						self::invalidate_config_cache();

						$spawned = Bootstrap::supervisor()->spawn_fleet( $name );

						return [
							'name'    => $name,
							'active'  => true,
							'spawned' => $spawned,
						];
					},
				],
				[
					'name'        => 'deactivate',
					'description' => 'Deactivate a topology: remove it from the active set, persist, and drain its fleet now.',
					'args'        => [ [ 'name' => 'name', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args ): array {
						self::require_manage_options();
						$name   = \trim( $args );
						$active = \array_values( \array_diff( \array_keys( Bootstrap::get_topologies() ), [ $name ] ) );
						\update_option( 'newspack_nodes_topologies', $active );
						self::invalidate_config_cache();

						Bootstrap::supervisor()->kill_readers( [ $name ] );

						return [
							'name'   => $name,
							'active' => false,
						];
					},
				],
				[
					'name'        => 'connect_worker_input',
					'description' => "Mount the named worker's input partition into this request's graph.",
					'args'        => [ [ 'name' => 'reader', 'type' => 'string', 'required' => true ] ],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args ): string {
						// Mount the named worker's input Partition into THIS request's graph so a
						// pivoted command in the same batch can route TO={reader}.pN. Returns '' (no reply).
						Bootstrap::register_worker_partition( \trim( $args ), Bootstrap::base_dir() );
						return '';
					},
				],
			],
		];
	}
}
