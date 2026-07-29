<?php
/**
 * Doctor's bounded web-runtime cache probe.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * @phpstan-import-type HealthResult from Health_Checks
 */
final class Health_Probe_Client {

	public const ROUTE = 'newspack-nodes/v1/health/cache';

	/** @var (\Closure(string,array<string,mixed>): mixed)|null */
	public static ?\Closure $http_call = null;

	/** @var (\Closure(): int)|null */
	public static ?\Closure $clock = null;

	private function __construct() {}

	/**
	 * Fetch the web runtime's cache result.
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
	 * Build a locally authored unknown-cache result.
	 *
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

	/**
	 * Classify a transport failure without surfacing its untrusted detail.
	 *
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
}
