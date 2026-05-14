<?php
/**
 * TopologiesController
 *   GET  /newspack-nodes/v1/topologies         (Task 4)
 *   POST /newspack-nodes/v1/topologies/{name}  (Task 5)
 *
 * GET is read-only (manage_options cap, no nonce).
 * POST writes a TSL file and triggers fleet restart for active names
 * (manage_options cap + wp_verify_nonce).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Config;
use Newspack_Nodes\Topology_Registry;

\defined( 'ABSPATH' ) || exit;

class TopologiesController {
	private const REST_NAMESPACE = 'newspack-nodes/v1';
	public  const NONCE_ACTION   = 'newspack_nodes_save_topology';
	private const NAME_PATTERN   = '/^[a-zA-Z0-9_-]+$/';
	private const MAX_BODY_BYTES = 65536;

	public function register_routes(): void {
		\register_rest_route(
			self::REST_NAMESPACE,
			'/topologies',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'get_topologies' ],
				'permission_callback' => [ $this, 'check_read_permission' ],
			]
		);
		\register_rest_route(
			self::REST_NAMESPACE,
			'/topologies/(?P<name>[a-zA-Z0-9_-]+)',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'save_topology' ],
				'permission_callback' => [ $this, 'check_write_permission' ],
			]
		);
		\register_rest_route(
			self::REST_NAMESPACE,
			'/topologies/(?P<name>[a-zA-Z0-9_-]+)',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'get_topology' ],
				'permission_callback' => [ $this, 'check_read_permission' ],
			]
		);
	}

	/**
	 * GET /newspack-nodes/v1/topologies/{name} — return the raw TSL
	 * body for a single topology, plus its source breakdown. Powers
	 * the editor's "Open existing topology" affordance.
	 *
	 * Lookup order matches Topology_Registry::resolve(): user-dir
	 * shadows stock, so the body returned is whichever copy the
	 * supervisor would actually load at spawn time.
	 */
	public function get_topology( \WP_REST_Request $request ): \WP_REST_Response {
		$name = (string) $request->get_param( 'name' );
		if ( ! \preg_match( self::NAME_PATTERN, $name ) ) {
			return new \WP_REST_Response(
				[
					'code'    => 'invalid_name',
					'message' => 'Topology name must match [a-zA-Z0-9_-]+',
				],
				400
			);
		}
		$path = Topology_Registry::resolve( $name );
		if ( null === $path ) {
			return new \WP_REST_Response(
				[
					'code'    => 'not_found',
					'message' => "No topology named '{$name}'.",
				],
				404
			);
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_get_contents,WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown -- Path is always a local .tsl file resolved via Topology_Registry; never a URL.
		$tsl = @\file_get_contents( $path );
		if ( false === $tsl ) {
			return new \WP_REST_Response(
				[
					'code'    => 'read_failed',
					'message' => "Failed to read {$path}",
				],
				500
			);
		}
		$sources   = Topology_Registry::describe()[ $name ] ?? [
			'user'  => null,
			'stock' => [],
		];
		$has_user  = null !== $sources['user'];
		$has_stock = ! empty( $sources['stock'] );
		$source    = ( $has_user && $has_stock )
			? 'both'
			: ( $has_user ? 'user' : 'stock' );
		return new \WP_REST_Response(
			[
				'name'   => $name,
				'source' => $source,
				'tsl'    => $tsl,
			],
			200
		);
	}

	public function check_read_permission(): bool|\WP_Error {
		if ( ! \function_exists( 'current_user_can' )
			|| ! \current_user_can( 'manage_options' ) ) {
			return new \WP_Error(
				'rest_forbidden',
				'manage_options capability required.',
				[ 'status' => 403 ]
			);
		}
		return true;
	}

	public function get_topologies( \WP_REST_Request $request ): \WP_REST_Response {
		// Active = whatever the supervisor would actually spawn. The
		// `newspack_nodes/topologies` filter is the single source of
		// truth for fleet configuration; reading the substrate's own
		// `topologies` config key would miss app-side filter additions.
		$resolved = \function_exists( 'apply_filters' )
			? (array) \apply_filters( 'newspack_nodes/topologies', [] )
			: [];
		$active = [];
		foreach ( $resolved as $name => $_def ) {
			if ( \is_string( $name ) && '' !== $name ) {
				$active[ $name ] = true;
			}
		}

		$out = [];
		foreach ( Topology_Registry::describe() as $name => $sources ) {
			$has_user  = null !== $sources['user'];
			$has_stock = ! empty( $sources['stock'] );
			$source    = ( $has_user && $has_stock )
				? 'both'
				: ( $has_user ? 'user' : 'stock' );

			$out[] = [
				'name'        => $name,
				'source'      => $source,
				'active'      => isset( $active[ $name ] ),
				'frontmatter' => Topology_Registry::frontmatter( $name ),
			];
		}
		\usort( $out, static fn ( $a, $b ) => $a['name'] <=> $b['name'] );

		return new \WP_REST_Response(
			[
				'topologies' => $out,
				'user_dir'   => Topology_Registry::user_dir(),
			],
			200
		);
	}

	public function check_write_permission( \WP_REST_Request $request ): bool|\WP_Error {
		$base = $this->check_read_permission();
		if ( \is_wp_error( $base ) ) {
			return $base;
		}
		// Read the per-action nonce from `save_nonce` (custom param name)
		// FIRST so apiFetch's wp_rest-nonce X-WP-Nonce header doesn't
		// shadow it. Standard `_wpnonce` is reserved by WP's cookie auth
		// layer for the wp_rest action — using a custom name keeps the
		// per-action nonce path independent of cookie auth. Header path
		// stays as a fallback for non-browser callers.
		$nonce = (string) (
			$request->get_param( 'save_nonce' )
				?: $request->get_header( 'x_wp_nonce' )
				?: ''
		);
		if ( '' === $nonce
			|| ! \function_exists( 'wp_verify_nonce' )
			|| ! \wp_verify_nonce( $nonce, self::NONCE_ACTION ) ) {
			return new \WP_Error(
				'rest_forbidden',
				'Invalid or missing security nonce.',
				[ 'status' => 403 ]
			);
		}
		return true;
	}

	public function save_topology( \WP_REST_Request $request ): \WP_REST_Response {
		$name = (string) $request->get_param( 'name' );
		if ( ! \preg_match( self::NAME_PATTERN, $name ) ) {
			return new \WP_REST_Response(
				[
					'code'    => 'invalid_name',
					'message' => 'Topology name must match [a-zA-Z0-9_-]+',
				],
				400
			);
		}

		$body = (string) $request->get_body();
		if ( \strlen( $body ) > self::MAX_BODY_BYTES ) {
			return new \WP_REST_Response(
				[
					'code'    => 'body_too_large',
					'message' => 'Topology body exceeds 64 KiB.',
				],
				413
			);
		}

		// Dry-run validation: every statement passes Shell's syntax check.
		// validate_line throws RuntimeException on forbidden verbs and
		// malformed continuations; parse() alone wouldn't catch the
		// forbidden cases (it just warns + returns null).
		$shell = new \Newspack_Nodes\Shell();
		$stmts = $shell->split_statements( $body );
		foreach ( $stmts as $i => $stmt ) {
			try {
				$shell->validate_line( $stmt );
			} catch ( \RuntimeException $e ) {
				return new \WP_REST_Response(
					[
						'code'        => 'validation_failed',
						'line_number' => $i + 1,
						'message'     => $e->getMessage(),
					],
					400
				);
			}
		}

		$user_dir = Topology_Registry::user_dir();
		if ( '' === $user_dir ) {
			return new \WP_REST_Response(
				[
					'code'    => 'user_dir_unconfigured',
					'message' => 'Topology_Registry has no writable user dir.',
				],
				500
			);
		}
		if ( ! \is_dir( $user_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			$made = @\mkdir( $user_dir, 0700, true );
			if ( ! $made && ! \is_dir( $user_dir ) ) {
				return new \WP_REST_Response(
					[
						'code'    => 'user_dir_unwritable',
						'message' => "Failed to create {$user_dir}",
					],
					500
				);
			}
		}

		// shadows_stock determined BEFORE writing so it reflects the
		// pre-existing stock state, not "we just made a user copy".
		$pre_sources = Topology_Registry::describe()[ $name ] ?? [ 'stock' => [] ];
		$shadows     = ! empty( $pre_sources['stock'] );

		$path = $user_dir . '/' . $name . '.tsl';
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		$bytes = \file_put_contents( $path, $body );
		if ( false === $bytes ) {
			return new \WP_REST_Response(
				[
					'code'    => 'write_failed',
					'message' => "Failed to write {$path}",
				],
				500
			);
		}

		// Trigger restart for any active fleet running this topology.
		// Same filter the supervisor uses — see get_topologies() above.
		$resolved  = \function_exists( 'apply_filters' )
			? (array) \apply_filters( 'newspack_nodes/topologies', [] )
			: [];
		$restarted = [];
		if ( isset( $resolved[ $name ] ) ) {
			\do_action( 'newspack_nodes/restart_fleet', $name );
			$restarted[] = $name;
		}

		return new \WP_REST_Response(
			[
				'name'             => $name,
				'path'             => $path,
				'shadows_stock'    => $shadows,
				'restarted_fleets' => $restarted,
			],
			201
		);
	}
}
