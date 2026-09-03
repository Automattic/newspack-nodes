<?php
/**
 * The REST route reporting the web runtime's cache posture to
 * `wp nodes doctor`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Core;
use Newspack_Nodes\Health_Checks;
use Newspack_Nodes\Internal_Request_Token;

\defined( 'ABSPATH' ) || exit;

/**
 * Answer `POST /newspack-nodes/v1/health/cache` with the cache-backend result
 * the request-serving process sees.
 *
 * `wp nodes doctor` runs under WP-CLI, which selects its own cache backend, so
 * a probe run there reports a posture no visitor ever gets.
 * `Health_Probe_Client` is the other half of the handshake: it mints the token
 * and POSTs across the loopback, and this controller runs the probe inside the
 * web runtime and hands the result back.
 *
 * The caller is the site itself and carries no user session, so the gate is an
 * `Internal_Request_Token` rather than a capability, which would refuse every
 * legitimate request. `Bootstrap::register_rest_routes()` registers this route
 * before any other, and nothing on the permission path reads the cache, the
 * base directory or a worker, so the probe still answers on an install whose
 * runtime base is refused — the state doctor is run to diagnose.
 */
final class Health_Cache_Controller {

	/**
	 * Wall-clock seam standing in for the `time()` call alone. Tests pin it to
	 * one fixed second so the shape pre-screen, the window arithmetic and the
	 * refusal messages around it run as production code and are really
	 * measured.
	 *
	 * Signature: `function (): int`.
	 *
	 * @var (\Closure(): int)|null
	 */
	public static ?\Closure $clock = null;

	/**
	 * Bind token validation to the site's nonce salt.
	 *
	 * `Bootstrap` passes `wp_salt( 'nonce' )`, the key `Health_Probe_Client`
	 * mints under; the two sides must agree or nothing validates. An empty salt
	 * would yield the same computable token on every install, so the controller
	 * refuses to exist rather than validate against it.
	 *
	 * @param string $nonce_salt HMAC key a presented token must validate under.
	 * @throws \InvalidArgumentException When the salt is empty.
	 */
	public function __construct( private readonly string $nonce_salt ) {
		if ( '' === $nonce_salt ) {
			throw new \InvalidArgumentException( 'Health cache controller requires a nonce salt' );
		}
	}

	/**
	 * Check whether a cache-health request is permitted.
	 *
	 * `Bootstrap::fleet_gate()` refuses first: the fleet is network-global,
	 * so a multisite subsite has no cache posture of its own to report,
	 * whatever token it carries. The regex then rejects anything but the
	 * exact mint shape, 64 lowercase hex characters, before an HMAC is spent.
	 * `Internal_Request_Token::validate()` accepts the current or the previous
	 * 10-second window, and refuses a token minted for another purpose.
	 *
	 * Both token refusals answer 403 under one code and echo nothing of what
	 * was presented, so a caller learns neither which check failed nor how
	 * close its token came.
	 *
	 * @param \WP_REST_Request $request Probe request; only `token` is read.
	 * @return true|\WP_Error True when the token validates, else a 403 error.
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

	/**
	 * Return the web process's canonical cache result.
	 *
	 * The probe reads nothing from the request.
	 * `Health_Checks::cache_backend()` picks its own backend, key and value,
	 * so a caller can steer neither what gets written nor what comes back,
	 * and a `key` or `value` sent along is used nowhere and returned nowhere.
	 *
	 * A failing cache still answers 200, because the check ran and its verdict
	 * is the payload. `Health_Probe_Client` reads every other status as an
	 * unverifiable loopback and downgrades to `recommended`, which would bury a
	 * `critical` finding behind a transport message.
	 *
	 * @param \WP_REST_Request $request Unused; the route reads no caller input.
	 * @return \WP_REST_Response The cache-backend result, HTTP 200.
	 */
	public function probe( \WP_REST_Request $request ): \WP_REST_Response {
		return new \WP_REST_Response( Health_Checks::cache_backend(), 200 );
	}

	/**
	 * Register the narrow internal cache-health route.
	 *
	 * Declaring `token` required hands the missing-token case to WordPress,
	 * which answers 400 `rest_missing_callback_param` before the permission
	 * callback runs. `sanitize_text_field` cleans the value without proving
	 * anything about it, so `check_permission()` still checks the shape.
	 */
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
