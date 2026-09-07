<?php
/**
 * The web runtime's cache posture, fetched over the loopback for `wp nodes doctor`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Fetch the cache-backend health result from the WEB runtime over the loopback.
 *
 * A CLI process picks its own cache backend, so `Health_Checks::cache_backend()`
 * run under WP-CLI reports a posture no visitor ever sees — WP-CLI's APCu is not
 * the web server's. Asking the web runtime through
 * `POST /newspack-nodes/v1/health/cache` reports the backend that serves
 * requests; `Rest\Health_Cache_Controller` is the half that answers.
 *
 * The reply is untrusted. It stands only when it matches the exact shape
 * `Health_Checks` produces, and every other outcome returns a locally authored
 * result rather than remote text, because doctor prints these messages to a
 * terminal.
 *
 * @phpstan-import-type HealthResult from Health_Checks
 */
final class Health_Probe_Client {

	/** REST route the web runtime answers the cache probe on. */
	public const ROUTE = 'newspack-nodes/v1/health/cache';

	/**
	 * Loopback-POST seam, standing in for the `wp_remote_post()` call alone.
	 * Tests assign it to capture the URL and arguments and to return a chosen
	 * response, so the token mint, the HTTP-status ladder and the result
	 * validation around it run as real code and are really measured.
	 *
	 * Signature: `function (string $url, array<string,mixed> $args): mixed`.
	 *
	 * @var (\Closure(string,array<string,mixed>): mixed)|null
	 */
	public static ?\Closure $http_call = null;

	/**
	 * Wall-clock seam for the token's 10-second window. Tests pin it so the
	 * minted token can be validated against a known window.
	 *
	 * Signature: `function (): int`.
	 *
	 * @var (\Closure(): int)|null
	 */
	public static ?\Closure $clock = null;

	/** Static-only: every entry point is a static method. */
	private function __construct() {}

	/**
	 * Fetch the web runtime's cache result, or a locally authored `recommended`
	 * result when the loopback cannot be verified.
	 *
	 * Two bounds hold the reply: 2048 bytes off the wire and a decode depth of
	 * 16, where the four-key result carries a few hundred bytes across two
	 * levels.
	 *
	 * Four rejections get their own message because each names a different fix:
	 * 301 through 399 is a redirect the probe declines to follow, a 401 means
	 * HTTP authentication fronts the site, a 403 means the route refused the
	 * token, and a 404 means the route is missing, as it would be when the CLI
	 * and web plugin versions differ. Every other status but 200 — 300 among
	 * them — reports its number and nothing more. The 401 also warns about
	 * worker respawn, which posts across the same loopback and meets the same
	 * HTTP-authentication gate.
	 *
	 * @return HealthResult
	 */
	public static function cache_backend(): array {
		$now   = ( self::$clock ?? static fn (): int => \time() )();
		$token = Internal_Request_Token::generate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			$now,
			\wp_salt( 'nonce' )
		);
		$url  = \rest_url( self::ROUTE );
		$args = [
			// 5s bound: doctor waits for this one diagnostic response.
			// phpcs:ignore WordPressVIPMinimum.Performance.RemoteRequestTimeout.timeout_timeout
			'timeout'             => 5,
			'redirection'         => 0,
			'limit_response_size' => 2048,
			// Both internal loopback calls share `spawn_verify_ssl`.
			'sslverify'           => Core::$verify_spawn_tls,
			'body'                => [ 'token' => $token ],
		];
		if ( null === self::$http_call ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.wp_remote_post_wp_remote_post -- Bounded internal loopback probe.
			$response = \wp_remote_post( $url, $args );
		} else {
			$response = ( self::$http_call )( $url, $args );
		}

		if ( $response instanceof \WP_Error ) {
			return self::transport_error( $response );
		}
		if ( ! \is_array( $response ) ) {
			return self::unknown( 'Could not verify the web cache backend because the loopback request returned a malformed HTTP response.' );
		}
		$code = \wp_remote_retrieve_response_code( $response );
		if ( ! \is_int( $code ) ) {
			return self::unknown( 'Could not verify the web cache backend because the loopback request returned a malformed HTTP response.' );
		}
		if ( 301 <= $code && 399 >= $code ) {
			return self::unknown( "Could not verify the web cache backend because the loopback request attempted an unsafe redirect (HTTP {$code})." );
		}
		if ( 401 === $code ) {
			return self::unknown( 'Could not verify the web cache backend because loopback HTTP authentication rejected the request (HTTP 401); normal worker respawn may also be impaired.' );
		}
		if ( 403 === $code ) {
			return self::unknown( 'Could not verify the web cache backend because the health route rejected its purpose-specific token (HTTP 403).' );
		}
		if ( 404 === $code ) {
			return self::unknown( 'Could not verify the web cache backend because the health route is unavailable (HTTP 404); the CLI and web plugin versions may differ.' );
		}
		if ( 200 !== $code ) {
			return self::unknown( "Could not verify the web cache backend because the health route returned HTTP {$code}." );
		}

		if ( ! \array_key_exists( 'body', $response ) || ! \is_string( $response['body'] ) ) {
			return self::unknown( 'Could not verify the web cache backend because the health route returned a malformed response body.' );
		}
		$body = $response['body'];
		try {
			$decoded = \json_decode(
				$body,
				true,
				16,
				\JSON_THROW_ON_ERROR
			);
		} catch ( \JsonException ) {
			return self::unknown( 'Could not verify the web cache backend because the health route returned malformed JSON.' );
		}

		if ( self::valid_result( $decoded ) ) {
			/** @var HealthResult $decoded */
			return $decoded;
		}
		return self::unknown( 'Could not verify the web cache backend because the health route returned a malformed result.' );
	}

	/**
	 * Accept only the exact result shape `Health_Checks::cache_backend()` emits.
	 *
	 * Doctor prints the message straight to a terminal, so this is a whitelist
	 * rather than a sanitizer: the four keys and no others, the substrate's own
	 * id and label, one of the three declared statuses, and exactly one message
	 * of 1 to 512 bytes that is valid UTF-8 and carries no control, line- or
	 * paragraph-separator character able to rewrite the surrounding output.
	 *
	 * @param mixed $result Decoded response body.
	 * @return bool Whether the payload may be returned verbatim.
	 */
	private static function valid_result( mixed $result ): bool {
		if ( ! \is_array( $result ) || \array_is_list( $result ) ) {
			return false;
		}

		$keys = \array_keys( $result );
		\sort( $keys );
		if ( [ 'id', 'label', 'messages', 'status' ] !== $keys ) {
			return false;
		}
		if (
			Health_Checks::CACHE_ID !== $result['id']
			|| Health_Checks::CACHE_LABEL !== $result['label']
			|| ! \in_array(
				$result['status'],
				[
					Health_Checks::STATUS_GOOD,
					Health_Checks::STATUS_RECOMMENDED,
					Health_Checks::STATUS_CRITICAL,
				],
				true
			)
		) {
			return false;
		}
		if (
			! \is_array( $result['messages'] )
			|| ! \array_is_list( $result['messages'] )
			|| 1 !== \count( $result['messages'] )
		) {
			return false;
		}

		$message = $result['messages'][0];
		return \is_string( $message )
			&& '' !== $message
			&& 512 >= \strlen( $message )
			&& 1 === \preg_match( '//u', $message )
			&& 0 === \preg_match( '/[\p{Cc}\p{Zl}\p{Zp}]/u', $message );
	}

	/**
	 * Classify a transport failure without surfacing its untrusted detail.
	 *
	 * The cURL text can carry a remote hostname or certificate subject, so the
	 * message is chosen from the classification and never quotes the error. A
	 * DNS, connection or TLS failure also warns about worker respawn, which
	 * dials the same loopback. A timeout is classified first and stays silent
	 * about respawn: a slow answer is not evidence the loopback is broken.
	 *
	 * @param \WP_Error $error Transport failure from the loopback request.
	 * @return HealthResult
	 */
	private static function transport_error( \WP_Error $error ): array {
		$detail = \strtolower( $error->get_error_message() );
		if ( \preg_match( '/curl error 28\b|timed out|timeout/', $detail ) ) {
			return self::unknown( 'Could not verify the web cache backend because the health request timed out.' );
		}
		if ( \preg_match( '/curl error (6|7|35|51|58|60|77)\b|could not resolve host|failed to connect|ssl certificate/', $detail ) ) {
			return self::unknown( 'Could not verify the web cache backend because loopback DNS, connection, or TLS failed; normal worker respawn may also be impaired.' );
		}
		return self::unknown( 'Could not verify the web cache backend because the loopback request failed.' );
	}

	/**
	 * Build a locally authored unknown-cache result.
	 *
	 * The status is `recommended`, not `critical`: an unverified cache is not a
	 * proven-broken one, and doctor exits 0 on a recommendation. `critical`
	 * belongs to `Health_Checks`, which reaches the backend and watches it fail.
	 *
	 * @param string $message Locally authored diagnostic, never remote text.
	 * @return HealthResult
	 */
	private static function unknown( string $message ): array {
		return [
			'id'       => Health_Checks::CACHE_ID,
			'label'    => Health_Checks::CACHE_LABEL,
			'status'   => Health_Checks::STATUS_RECOMMENDED,
			'messages' => [ $message ],
		];
	}
}
