<?php
/**
 * Internal web-runtime cache health probe.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Core;
use Newspack_Nodes\Health_Checks;
use Newspack_Nodes\Internal_Request_Token;

\defined( 'ABSPATH' ) || exit;

final class Health_Cache_Controller {

	/** @var (\Closure(): int)|null */
	public static ?\Closure $clock = null;

	/** Bind token validation to the site's nonce salt. */
	public function __construct( private readonly string $nonce_salt ) {
		if ( '' === $nonce_salt ) {
			throw new \InvalidArgumentException( 'Health cache controller requires a nonce salt' );
		}
	}

	/**
	 * Check whether a cache-health request is permitted.
	 *
	 * @return true|\WP_Error
	 */
	public function check_permission( \WP_REST_Request $request ) {
		$gate = Bootstrap::fleet_gate();
		if ( null !== $gate ) {
			return $gate;
		}
		$token = Core::as_string( $request->get_param( 'token' ) );
		if ( ! \preg_match( '/\A[a-f0-9]{64}\z/', $token ) ) {
			return new \WP_Error(
				'invalid_health_token',
				'Missing or invalid health token',
				[ 'status' => 403 ]
			);
		}
		$now = ( self::$clock ?? static fn (): int => \time() )();
		if ( ! Internal_Request_Token::validate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			$token,
			$now,
			$this->nonce_salt
		) ) {
			return new \WP_Error(
				'invalid_health_token',
				'Invalid health token',
				[ 'status' => 403 ]
			);
		}
		return true;
	}

	/** Return the web process's canonical cache result. */
	public function probe( \WP_REST_Request $request ): \WP_REST_Response {
		return new \WP_REST_Response( Health_Checks::cache_backend(), 200 );
	}

	/** Register the narrow internal cache-health route. */
	public function register_routes(): void {
		\register_rest_route(
			'newspack-nodes/v1',
			'/health/cache',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'probe' ],
				'permission_callback' => [ $this, 'check_permission' ],
				'args'                => [
					'token' => [
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
					],
				],
			]
		);
	}
}
