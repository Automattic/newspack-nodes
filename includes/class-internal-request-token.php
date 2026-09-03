<?php
/**
 * Purpose-separated HMACs authorizing the substrate's internal loopback requests.
 *
 * Two endpoints are called by the site itself rather than by a person: the
 * spawn controller a worker, a peer scan or the cron pass POSTs to, and the
 * health-cache probe `wp nodes doctor` reads the WEB runtime's posture from.
 * Neither caller carries a user session, so a capability check would refuse
 * every legitimate request; each presents a token minted from a shared secret
 * instead.
 *
 * The purpose string sits INSIDE the hashed message, so a token minted for one
 * endpoint never validates at the other and a leaked one reaches only the
 * endpoint it was issued for.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Mints and validates the internal loopback tokens.
 *
 * A token is the hex SHA-256 HMAC of `newspack_nodes_{purpose}:{window}` keyed
 * by the caller's salt: 64 lowercase hex characters, the shape
 * `Health_Cache_Controller` pre-screens with a regex before spending an HMAC.
 *
 * The clock and the salt are parameters rather than `time()` and `wp_salt()`
 * calls, which keeps the class free of WordPress and lets a test drive both
 * sides of a handshake from one fixed second. Choosing the key is the caller's
 * job — `Spawn_Coordinator` derives a dedicated spawn key, `Health_Probe_Client`
 * passes `wp_salt( 'nonce' )` — and the two sides of one purpose must agree on
 * it or nothing validates.
 */
final class Internal_Request_Token {
	/**
	 * Seconds one token window covers.
	 *
	 * Because `validate()` takes the previous window too, a token lives between
	 * 10 and 20 seconds. That straddle absorbs the clock skew and the request
	 * latency between minting and arrival; accepting one window alone fails
	 * every mint that lands after a boundary. Do not tighten it.
	 */
	public const WINDOW_S = 10;

	/** Purpose for `POST /v1/workers/spawn`, minted by `Spawn_Coordinator`. */
	public const PURPOSE_SPAWN = 'spawn';

	/** Purpose for `POST /v1/health/cache`, minted by `Health_Probe_Client`. */
	public const PURPOSE_HEALTH_CACHE = 'health-cache';

	/** Static only: a token is a pure function of its inputs, so there is nothing to hold. */
	private function __construct() {}

	/**
	 * Mint the token for one purpose and the window containing $now.
	 *
	 * @param string $purpose One of the PURPOSE_* constants.
	 * @param int    $now     Unix time to mint against.
	 * @param string $salt    HMAC key; the validating side must use the same one.
	 * @return string 64-character lowercase hex HMAC.
	 * @throws \InvalidArgumentException When the purpose or the salt is empty.
	 */
	public static function generate( string $purpose, int $now, string $salt ): string {
		self::require_inputs( $purpose, $salt );
		$window = (int) \floor( $now / self::WINDOW_S );
		return self::for_window( $purpose, $window, $salt );
	}

	/**
	 * Accept only the current or immediately previous window for one purpose.
	 *
	 * Each candidate is compared through `hash_equals()`, so a wrong token
	 * reveals nothing about how many of its bytes were right.
	 *
	 * @param string $purpose One of the PURPOSE_* constants.
	 * @param string $token   Token as the caller presented it.
	 * @param int    $now     Unix time the token arrived.
	 * @param string $salt    HMAC key the token was minted under.
	 * @return bool True when the token matches the current or the previous window.
	 * @throws \InvalidArgumentException When the purpose or the salt is empty.
	 */
	public static function validate( string $purpose, string $token, int $now, string $salt ): bool {
		self::require_inputs( $purpose, $salt );
		$window   = (int) \floor( $now / self::WINDOW_S );
		$current  = self::for_window( $purpose, $window, $salt );
		$previous = self::for_window( $purpose, $window - 1, $salt );
		return \hash_equals( $current, $token ) || \hash_equals( $previous, $token );
	}

	/**
	 * HMAC one purpose against one window number.
	 *
	 * The purpose is hashed with the window rather than carried beside it, which
	 * is what keeps a spawn token from validating at the health probe even when
	 * both endpoints share a salt.
	 *
	 * @param string $purpose One of the PURPOSE_* constants.
	 * @param int    $window  Window number, `floor( $now / WINDOW_S )`.
	 * @param string $salt    HMAC key.
	 * @return string 64-character lowercase hex HMAC.
	 */
	private static function for_window( string $purpose, int $window, string $salt ): string {
		return \hash_hmac( 'sha256', "newspack_nodes_{$purpose}:{$window}", $salt );
	}

	/**
	 * Refuse an empty purpose or an empty salt.
	 *
	 * Both still produce a token, which is the danger: an empty salt yields the
	 * same token on every install, so anyone knowing the algorithm can compute
	 * it, and an empty purpose collapses the separation the constants exist for.
	 * A caller that reaches here has a broken key or a missing constant, so it
	 * throws instead of minting something that authorizes the wrong request.
	 *
	 * @param string $purpose Purpose to check.
	 * @param string $salt    HMAC key to check.
	 * @throws \InvalidArgumentException When either is empty.
	 */
	private static function require_inputs( string $purpose, string $salt ): void {
		if ( '' === $purpose || '' === $salt ) {
			throw new \InvalidArgumentException( 'Internal request tokens require a purpose and salt' );
		}
	}
}
