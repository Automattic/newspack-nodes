<?php
/**
 * Topologies_CI: command-dispatch for substrate topology-management verbs.
 *
 * Topologies are .tsl files describing the node graph. User copies at
 * `{user_dir}/{name}.tsl` shadow plugin-shipped stock copies; this CI honors
 * that resolution order and only mutates the (writable) user dir.
 *
 * Verbs:
 *   list   — `{topologies: [{name, source, active, frontmatter}], user_dir}`.
 *            `source` is 'user'|'stock'|'both'; `active` follows the operator overlay.
 *   get    — args `{name}`. Returns `{name, source, tsl}`; throws on miss.
 *   save   — args `{name, tsl}`. Returns `{name, path, shadows_stock,
 *            restarted_fleets}`. 64 KiB cap; dry-run validation via
 *            Shell::validate_line; restarts the matching active fleet.
 *   delete — args `{name}`. Returns `{name, deleted, stock_fallback,
 *            restarted_fleets}`. User copy only (stock immutable); restarts
 *            the matching active fleet (symmetry with save).
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

	private const MAX_BODY_BYTES = 65536;

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Topology (.tsl) management: list / get / save / delete user topology files, and mount a worker input partition.',
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
							if ( \is_string( $name ) && '' !== $name ) {
								$active[ $name ] = true;
							}
						}

						$out = [];
						foreach ( Topology_Registry::describe() as $name => $sources ) {
							$out[] = [
								'name'        => $name,
								'source'      => self::source_of( $sources ),
								'active'      => isset( $active[ $name ] ),
								'frontmatter' => Topology_Registry::frontmatter( $name ),
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
						$name = self::require_valid_name( [ 'name' => \trim( $args ) ] );

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
					'description' => 'Write a user topology .tsl (validated; restarts the active fleet). 64 KiB cap.',
					'args'        => [
						[ 'name' => 'name', 'type' => 'string', 'required' => true ],
						[ 'name' => 'tsl', 'type' => 'text', 'required' => true ],
					],
					'handler'     => static function ( Command_Interpreter_Node $self, string $args, array $envelope, mixed $payload ): array {
						self::require_manage_options();
						if ( Message::packed_size( $envelope ) > self::MAX_BODY_BYTES ) {
							throw new \RuntimeException(
								\esc_html( 'body too large: topology payload exceeds 64 KiB' )
							);
						}
						$decoded = \is_array( $payload ) ? $payload : [];
						$name    = self::require_valid_name( $decoded );
						if ( ! isset( $decoded['tsl'] ) || ! \is_string( $decoded['tsl'] ) ) {
							throw new \RuntimeException( 'invalid arguments: tsl must be a string' );
						}
						$tsl = $decoded['tsl'];

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
						$name = self::require_valid_name( [ 'name' => \trim( $args ) ] );

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
							'restarted_fleets' => $restarted,
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
}
