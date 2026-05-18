<?php
/**
 * Topologies_CI: command-dispatch for substrate topology-management verbs.
 *
 * Replaces legacy class-topologies-controller.php (the GET/POST/DELETE
 * /topologies REST endpoints) with a CommandInterpreter the M3
 * Command_Controller mounts alongside the other substrate-side CIs.
 *
 * Topologies are .tsl files describing the node graph. The supervisor
 * loads them at worker startup; the topology editor manages them via
 * this CI. Per Topology_Registry, user copies at `{user_dir}/{name}.tsl`
 * shadow stock copies shipped by plugins. The CI honors that resolution
 * order and only mutates the user dir — stock copies are immutable.
 *
 * Verbs:
 *   list   — args `{}`. Returns `{topologies: [{name, source, active,
 *            frontmatter}], user_dir}`. `source` is 'user'|'stock'|'both'.
 *            `active` follows Bootstrap::get_topologies() (the operator
 *            overlay), matching what the supervisor actually spawns.
 *            Read perm.
 *   get    — args `{name}`. Returns `{name, source, tsl: string}`.
 *            Throws "no topology named: <name>" on miss. Read perm.
 *   save   — args `{name, tsl: string}`. Returns `{name, path,
 *            shadows_stock, restarted_fleets}`. Body capped at 64 KiB.
 *            Dry-run validation via Shell::validate_line — forbidden
 *            verbs (if/while/etc.) and malformed continuations get
 *            "validation failed at line N: <reason>". After write, if
 *            $name is in `apply_filters('newspack_nodes/topologies', [])`
 *            (the raw catalog filter — same surface the supervisor uses),
 *            fire `do_action('newspack_nodes/restart_fleet', $name)`.
 *            Write perm (manage_options).
 *   delete — args `{name}`. Returns `{name, deleted, stock_fallback}`.
 *            Removes USER copy only (stock files are immutable). Throws
 *            "no user-saved topology named: <name>" if no user file. After
 *            unlink, `stock_fallback` is true iff a stock copy remains.
 *            Write perm (manage_options).
 *
 * The legacy controller's nonce check is dropped — CI dispatch happens
 * post-auth via Command_Controller, so verb-level checks are limited to
 * the capability (`manage_options`). Errors throw RuntimeException;
 * CommandInterpreter::interpret() wraps them as TM_COMMAND | TM_ERROR.
 *
 * The require_manage_options / decode_args / require_valid_name helpers
 * are inherited from Service_CI (the shared base class), so this file no
 * longer carries local copies.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Message;
use Newspack_Nodes\Service_CI;
use Newspack_Nodes\Shell;
use Newspack_Nodes\Topology_Registry;

\defined( 'ABSPATH' ) || exit;

class Topologies_CI extends Service_CI {

	private const MAX_BODY_BYTES = 65536;

	public function __construct() {
		// Node + CommandInterpreter have no explicit __construct; the
		// inherited no-op is implicit. Mirrors M3 Classes_CI / Layouts_CI.
		$this->commands( $this->verb_table() );
	}

	private function verb_table(): array {
		return [
			'list'   => static function ( CommandInterpreter $self, string $args, array $envelope = [] ): string {
				// Active = whatever the supervisor would actually spawn. Read
				// through Bootstrap::get_topologies() so the merged catalog +
				// `newspack_nodes_topologies` operator overlay drives the flag.
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

				return (string) \wp_json_encode(
					[
						'topologies' => $out,
						'user_dir'   => Topology_Registry::user_dir(),
					]
				);
			},
			'get'    => static function ( CommandInterpreter $self, string $args, array $envelope, mixed $payload ): string {
				$decoded = \is_array( $payload ) ? $payload : [];
				$name    = self::require_valid_name( $decoded );

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

				return (string) \wp_json_encode(
					[
						'name'   => $name,
						'source' => self::source_of( $sources ),
						'tsl'    => $tsl,
					]
				);
			},
			'save'   => static function ( CommandInterpreter $self, string $args, array $envelope, mixed $payload ): string {
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

				// Dry-run validation: every statement passes Shell's syntax
				// check. validate_line throws on forbidden verbs (if/while/
				// for/func/eval/unless/until) and unterminated continuations.
				// Report the offending line number (1-based) so the editor
				// can show the cursor at the failing line.
				$shell = new Shell();
				foreach ( $shell->split_statements( $tsl ) as $i => $stmt ) {
					try {
						$shell->validate_line( $stmt );
					} catch ( \RuntimeException $e ) {
						// Don't esc_html() the compound message: $line_no
						// is an int, and $e->getMessage() is already-safe
						// content from Shell (which esc_html()'d its own
						// dynamic tokens). Re-escaping HTML-encodes the
						// quote characters Shell added around the verb,
						// turning "forbidden verb 'if'" into
						// "forbidden verb &#039;if&#039;" — which makes the
						// editor's "show me the offending verb" UX worse,
						// not safer.
						$line_no = $i + 1;
						$msg     = $e->getMessage();
						// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- $line_no is int; $msg is pre-sanitized by Shell::validate_line.
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

				// shadows_stock determined BEFORE writing so it reflects the
				// pre-existing stock state, not "we just made a user copy".
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

				// Trigger restart for any active fleet running this topology.
				// Same raw catalog filter the supervisor's bootstrap walks —
				// not the operator overlay, since this is "what topologies
				// might be running right now" rather than "what's checked".
				$resolved  = \function_exists( 'apply_filters' )
					? (array) \apply_filters( 'newspack_nodes/topologies', [] )
					: [];
				$restarted = [];
				if ( isset( $resolved[ $name ] ) ) {
					\do_action( 'newspack_nodes/restart_fleet', $name );
					$restarted[] = $name;
				}

				return (string) \wp_json_encode(
					[
						'name'             => $name,
						'path'             => $path,
						'shadows_stock'    => $shadows,
						'restarted_fleets' => $restarted,
					]
				);
			},
			'delete' => static function ( CommandInterpreter $self, string $args, array $envelope, mixed $payload ): string {
				self::require_manage_options();
				$decoded = \is_array( $payload ) ? $payload : [];
				$name    = self::require_valid_name( $decoded );

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
				// After unlink, resolve() returns the stock copy iff one
				// exists. Use it as the canonical "is there a fallback?"
				// signal rather than re-scanning describe().
				$has_stock_fallback = null !== Topology_Registry::resolve( $name );

				return (string) \wp_json_encode(
					[
						'name'           => $name,
						'deleted'        => $path,
						'stock_fallback' => $has_stock_fallback,
					]
				);
			},
		];
	}

	/**
	 * Reduce a Topology_Registry::describe() entry to its 'user'|'stock'|'both'
	 * label. Pulled out so list+get stay byte-for-byte consistent on the
	 * source flag — the legacy controller had two copies of this rule and
	 * the parity tests rely on them never drifting.
	 *
	 * @param array{user:?string,stock:array<int,string>} $sources Entry from
	 *        `Topology_Registry::describe()[$name]`.
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
