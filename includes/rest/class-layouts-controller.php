<?php
/**
 * LayoutsController
 *   GET  /newspack-nodes/v1/layouts/{name}  — fetch saved layout
 *   POST /newspack-nodes/v1/layouts/{name}  — write saved layout
 *
 * Layouts are decoupled from topologies — the TSL file describes
 * the graph (nodes, edges, verbs); the `.layout` file describes
 * positions. The supervisor never reads layouts; only the topology
 * console does, as a default for the canvas's "Reset Layout"
 * affordance.
 *
 * Files live at `<base_directory>/layouts/<name>.layout`, JSON
 * encoded as `{ positions: { node_id: [x, y], ... } }`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Config;

\defined( 'ABSPATH' ) || exit;

class LayoutsController {
	private const REST_NAMESPACE = 'newspack-nodes/v1';
	public  const NONCE_ACTION   = 'newspack_nodes_save_layout';
	private const NAME_PATTERN   = '/^[a-zA-Z0-9_-]+$/';
	private const MAX_BODY_BYTES = 65536;

	public function register_routes(): void {
		\register_rest_route(
			self::REST_NAMESPACE,
			'/layouts/(?P<name>[a-zA-Z0-9_-]+)',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'get_layout' ],
				'permission_callback' => [ $this, 'check_read_permission' ],
			]
		);
		\register_rest_route(
			self::REST_NAMESPACE,
			'/layouts/(?P<name>[a-zA-Z0-9_-]+)',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'save_layout' ],
				'permission_callback' => [ $this, 'check_write_permission' ],
			]
		);
	}

	private function error_response( string $code, string $message, int $status ): \WP_REST_Response {
		return new \WP_REST_Response( [ 'code' => $code, 'message' => $message ], $status );
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

	public function check_write_permission( \WP_REST_Request $request ): bool|\WP_Error {
		$base = $this->check_read_permission();
		if ( \is_wp_error( $base ) ) {
			return $base;
		}
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

	private function layouts_dir(): string {
		$base = (string) ( Config::load_config()['base_directory'] ?? '/tmp/newspack-nodes' );
		return \rtrim( $base, '/' ) . '/layouts';
	}

	private function layout_path( string $name ): string {
		return $this->layouts_dir() . '/' . $name . '.layout';
	}

	public function get_layout( \WP_REST_Request $request ): \WP_REST_Response {
		$name = (string) $request->get_param( 'name' );
		if ( ! \preg_match( self::NAME_PATTERN, $name ) ) {
			return $this->error_response( 'invalid_name', 'Layout name must match [a-zA-Z0-9_-]+', 400 );
		}
		$path = $this->layout_path( $name );
		if ( ! \file_exists( $path ) ) {
			return new \WP_REST_Response( [ 'name' => $name, 'positions' => null ], 200 );
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_get_contents,WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown -- Path is always a local .layout file.
		$body = @\file_get_contents( $path );
		if ( false === $body ) {
			return $this->error_response( 'read_failed', "Failed to read {$path}", 500 );
		}
		$decoded = \json_decode( $body, true );
		if ( ! \is_array( $decoded ) ) {
			return new \WP_REST_Response( [ 'name' => $name, 'positions' => null ], 200 );
		}
		return new \WP_REST_Response(
			[ 'name' => $name, 'positions' => $decoded['positions'] ?? null ],
			200
		);
	}

	public function save_layout( \WP_REST_Request $request ): \WP_REST_Response {
		$name = (string) $request->get_param( 'name' );
		if ( ! \preg_match( self::NAME_PATTERN, $name ) ) {
			return $this->error_response( 'invalid_name', 'Layout name must match [a-zA-Z0-9_-]+', 400 );
		}

		$body = (string) $request->get_body();
		if ( \strlen( $body ) > self::MAX_BODY_BYTES ) {
			return $this->error_response( 'body_too_large', 'Layout body exceeds 64 KiB.', 413 );
		}
		$payload = \json_decode( $body, true );
		if ( ! \is_array( $payload ) || ! isset( $payload['positions'] ) || ! \is_array( $payload['positions'] ) ) {
			return $this->error_response( 'invalid_body', 'Body must be JSON { "positions": { node_id: [x, y] } }', 400 );
		}

		// Sanitize positions: numeric pairs only.
		$clean = [];
		foreach ( $payload['positions'] as $id => $pos ) {
			if ( ! \is_string( $id ) || ! \is_array( $pos ) || \count( $pos ) < 2 ) {
				continue;
			}
			if ( ! \preg_match( '/^[a-zA-Z0-9_:.-]+$/', $id ) ) {
				continue;
			}
			$x = (float) $pos[0];
			$y = (float) $pos[1];
			if ( ! \is_finite( $x ) || ! \is_finite( $y ) ) {
				continue;
			}
			$clean[ $id ] = [ $x, $y ];
		}

		$dir = $this->layouts_dir();
		if ( ! \is_dir( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			$made = @\mkdir( $dir, 0700, true );
			if ( ! $made && ! \is_dir( $dir ) ) {
				return $this->error_response( 'dir_unwritable', "Failed to create {$dir}", 500 );
			}
		}

		$path = $this->layout_path( $name );
		$json = \wp_json_encode( [ 'positions' => $clean ] );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		$bytes = \file_put_contents( $path, $json );
		if ( false === $bytes ) {
			return $this->error_response( 'write_failed', "Failed to write {$path}", 500 );
		}
		return new \WP_REST_Response(
			[ 'name' => $name, 'path' => $path, 'positions' => $clean ],
			201
		);
	}
}
