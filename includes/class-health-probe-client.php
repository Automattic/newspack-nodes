<?php
/**
 * The web runtime's own health rows, fetched over the loopback for `wp nodes doctor`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Fetch the web runtime's `Health_Checks::runtime()` rows over the loopback:
 * its cache backend and its log-source registry.
 *
 * A CLI process picks its own cache backend and reads its own php.ini, so
 * either check run under WP-CLI can report a posture no visitor and no worker
 * ever sees — WP-CLI's APCu is not the web server's, and a built-in source
 * resolved from its ini may not be the one a worker resolves. Asking the web runtime through
 * `POST /newspack-nodes/v1/health/runtime` reports the posture that serves
 * requests and runs workers; `Rest\Health_Runtime_Controller` is the half that
 * answers.
 *
 * The reply is untrusted. It stands only whole, both rows in order, each the
 * exact shape `Health_Checks` produces, and every other outcome returns
 * locally authored rows rather than remote text, because doctor prints these
 * messages to a terminal.
 *
 * @phpstan-import-type HealthResult from Health_Checks
 */
final class Health_Probe_Client {

	/**
	 * REST route the web runtime answers its health rows on, under
	 * `HTTP_In_Node::REST_NAMESPACE`: the client posts to it and
	 * `Health_Runtime_Controller` registers it.
	 */
	public const ROUTE = '/health/runtime';

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
	 * Fetch the web runtime's rows, or locally authored `recommended` rows when
	 * the loopback cannot be verified.
	 *
	 * Two bounds hold the reply: 4096 bytes off the wire and a decode depth of
	 * 16, where the two four-key rows carry at most
	 * `Health_Checks::MESSAGE_BYTES` message bytes each across three levels.
	 *
	 * Four rejections get their own reason because each names a different fix:
	 * 301 through 399 is a redirect the probe declines to follow, a 401 means
	 * HTTP authentication fronts the site, a 403 means the route refused the
	 * token, and a 404 means the route is missing, as it would be when the CLI
	 * and web plugin versions differ. Every other status but 200 — 300 among
	 * them — reports its number and nothing more. The 401 also warns about
	 * worker respawn, which posts across the same loopback and meets the same
	 * HTTP-authentication gate.
	 *
	 * @return list<HealthResult>
	 */
	public static function runtime(): array {
		$now   = ( self::$clock ?? static fn (): int => \time() )();
		$token = Internal_Request_Token::generate(
			Internal_Request_Token::PURPOSE_HEALTH_RUNTIME,
			$now,
			\wp_salt( 'nonce' )
		);
		$url  = \rest_url( Rest\HTTP_In_Node::REST_NAMESPACE . self::ROUTE );
		$args = [
			// 5s bound: doctor waits for this one diagnostic response.
			// phpcs:ignore WordPressVIPMinimum.Performance.RemoteRequestTimeout.timeout_timeout
			'timeout'             => 5,
			'redirection'         => 0,
			'limit_response_size' => 4096,
			// Both internal loopback calls share `spawn_verify_ssl`.
			'sslverify'           => Core::verify_spawn_tls(),
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
			return self::unknown( 'the loopback request returned a malformed HTTP response' );
		}
		$code = \wp_remote_retrieve_response_code( $response );
		if ( ! \is_int( $code ) ) {
			return self::unknown( 'the loopback request returned a malformed HTTP response' );
		}
		if ( 301 <= $code && 399 >= $code ) {
			return self::unknown( "the loopback request attempted an unsafe redirect (HTTP {$code})" );
		}
		if ( 401 === $code ) {
			return self::unknown( 'loopback HTTP authentication rejected the request (HTTP 401); normal worker respawn may also be impaired' );
		}
		if ( 403 === $code ) {
			return self::unknown( 'the health route rejected its purpose-specific token (HTTP 403)' );
		}
		if ( 404 === $code ) {
			return self::unknown( 'the health route is unavailable (HTTP 404); the CLI and web plugin versions may differ' );
		}
		if ( 200 !== $code ) {
			return self::unknown( "the health route returned HTTP {$code}" );
		}

		if ( ! \array_key_exists( 'body', $response ) || ! \is_string( $response['body'] ) ) {
			return self::unknown( 'the health route returned a malformed response body' );
		}
		try {
			$decoded = \json_decode( $response['body'], true, 16, \JSON_THROW_ON_ERROR );
		} catch ( \JsonException ) {
			return self::unknown( 'the health route returned malformed JSON' );
		}

		if ( self::valid_rows( $decoded ) ) {
			/** @var list<HealthResult> $decoded */
			return $decoded;
		}
		return self::unknown( 'the health route returned a malformed result' );
	}

	/**
	 * Accept only `Health_Checks::runtime_rows()`, in order, each the exact
	 * shape `Health_Checks` emits.
	 *
	 * @param mixed $rows Decoded response body.
	 * @return bool Whether the payload may be returned verbatim.
	 */
	private static function valid_rows( mixed $rows ): bool {
		$table = Health_Checks::runtime_rows();
		if ( ! \is_array( $rows ) || ! \array_is_list( $rows ) || \count( $table ) !== \count( $rows ) ) {
			return false;
		}
		foreach ( \array_keys( $table ) as $index => $id ) {
			if ( ! self::valid_result( $rows[ $index ], $id, $table[ $id ]['label'] ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Accept only the exact result shape `Health_Checks` emits for one row.
	 *
	 * Doctor prints the message straight to a terminal, so this is a whitelist
	 * rather than a sanitizer: the four keys and no others, the row's own id
	 * and label, one of the three declared statuses, and exactly one message
	 * of 1 to `Health_Checks::MESSAGE_BYTES` bytes that is valid UTF-8 and
	 * holds no `Health_Checks::WIRE_CONTROL` character able to rewrite the
	 * surrounding output.
	 *
	 * @param mixed  $result Decoded row.
	 * @param string $id     The id the row must carry.
	 * @param string $label  The label the row must carry.
	 * @return bool Whether the row may be returned verbatim.
	 */
	private static function valid_result( mixed $result, string $id, string $label ): bool {
		if ( ! \is_array( $result ) || \array_is_list( $result ) ) {
			return false;
		}

		$keys = \array_keys( $result );
		\sort( $keys );
		if ( [ 'id', 'label', 'messages', 'status' ] !== $keys ) {
			return false;
		}
		if (
			$id !== $result['id']
			|| $label !== $result['label']
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
			&& Health_Checks::MESSAGE_BYTES >= \strlen( $message )
			&& 1 === \preg_match( '//u', $message )
			&& 0 === \preg_match( Health_Checks::WIRE_CONTROL, $message );
	}

	/**
	 * Classify a transport failure without surfacing its untrusted detail.
	 *
	 * The cURL text can carry a remote hostname or certificate subject, so the
	 * reason is chosen from the classification and never quotes the error. A
	 * DNS, connection or TLS failure also warns about worker respawn, which
	 * dials the same loopback. A timeout is classified first and stays silent
	 * about respawn: a slow answer is not evidence the loopback is broken.
	 *
	 * @param \WP_Error $error Transport failure from the loopback request.
	 * @return list<HealthResult>
	 */
	private static function transport_error( \WP_Error $error ): array {
		$detail = \strtolower( $error->get_error_message() );
		if ( \preg_match( '/curl error 28\b|timed out|timeout/', $detail ) ) {
			return self::unknown( 'the health request timed out' );
		}
		if ( \preg_match( '/curl error (6|7|35|51|58|60|77)\b|could not resolve host|failed to connect|ssl certificate/', $detail ) ) {
			return self::unknown( 'loopback DNS, connection, or TLS failed; normal worker respawn may also be impaired' );
		}
		return self::unknown( 'the loopback request failed' );
	}

	/**
	 * Build every row as locally authored and unverified, for one reason.
	 *
	 * The status is `recommended`, not `critical`: an unverified row is not a
	 * proven-broken one, and doctor exits 0 on a recommendation. `critical`
	 * belongs to `Health_Checks`, which reaches the backend and watches it fail.
	 *
	 * @param string $reason Locally authored diagnostic, never remote text.
	 * @return list<HealthResult>
	 */
	private static function unknown( string $reason ): array {
		$rows = [];
		foreach ( Health_Checks::runtime_rows() as $id => $row ) {
			$rows[] = [
				'id'       => $id,
				'label'    => $row['label'],
				'status'   => Health_Checks::STATUS_RECOMMENDED,
				'messages' => [ "Could not verify {$row['subject']} because {$reason}." ],
			];
		}
		return $rows;
	}
}
