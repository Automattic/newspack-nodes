<?php
/**
 * SpawnController: REST endpoint that spawns a worker zombie-process.
 *
 * Accepts POST /newspack-nodes/v1/workers/spawn with {type, partition, nonce}.
 * Validates the HMAC token via Supervisor, acknowledges the request synchronously,
 * detaches via fastcgi_finish_request() + ignore_user_abort(), and fires the
 * `newspack_nodes/spawn_worker` action — topology owners hook this to instantiate
 * the right worker class for `$type` and call `->execute()`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Supervisor;

\defined( 'ABSPATH' ) || exit;

class SpawnController {
	private Supervisor $supervisor;

	public function __construct( Supervisor $supervisor ) {
		$this->supervisor = $supervisor;
	}

	public function register_routes(): void {
		\register_rest_route(
			'newspack-nodes/v1',
			'/workers/spawn',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'spawn' ],
				'permission_callback' => [ $this, 'check_permission' ],
				'args'                => [
					'type'      => [
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
					],
					'partition' => [
						'required'          => true,
						'sanitize_callback' => static fn ( $v ) => (int) $v,
					],
					'nonce'     => [
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
					],
				],
			]
		);
	}

	/**
	 * Permission check: HMAC token must validate (current or previous 10s window).
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return bool|\WP_Error
	 */
	public function check_permission( \WP_REST_Request $req ) {
		$nonce = (string) $req->get_param( 'nonce' );
		if ( $nonce === '' || ! $this->supervisor->validate_spawn_token( $nonce, \time() ) ) {
			return new \WP_Error( 'invalid_token', 'Invalid spawn token', [ 'status' => 403 ] );
		}
		return true;
	}

	/**
	 * Spawn handler: detach from FPM, fire spawn action so topology owners can
	 * instantiate the right worker.
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return \WP_REST_Response
	 */
	public function spawn( \WP_REST_Request $req ): \WP_REST_Response {
		$type      = (string) $req->get_param( 'type' );
		$partition = (int) $req->get_param( 'partition' );

		$response = new \WP_REST_Response( [ 'spawned' => true ], 200 );

		// Acknowledge synchronously; do the work zombie-style.
		// Skip the FPM detach in CLI/test contexts where the function is a no-op.
		if ( \function_exists( 'fastcgi_finish_request' ) ) {
			\fastcgi_finish_request();
		}
		\ignore_user_abort( true );
		\set_time_limit( 0 );

		// Store worker context in $_SERVER for sub-actions / logging.
		$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = $type;
		$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = (string) $partition;

		\do_action( 'newspack_nodes/spawn_worker', $type, $partition );

		return $response;
	}
}
