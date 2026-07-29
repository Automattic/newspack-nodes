<?php
/**
 * Purpose-separated HMACs for short-lived internal loopback requests.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

final class Internal_Request_Token {
	public const WINDOW_S = 10;

	public const PURPOSE_SPAWN = 'spawn';

	public const PURPOSE_HEALTH_CACHE = 'health-cache';

	private function __construct() {}

	/** Generate the token for one purpose and time window. */
	public static function generate( string $purpose, int $now, string $salt ): string {
		self::require_inputs( $purpose, $salt );
		$window = (int) \floor( $now / self::WINDOW_S );
		return self::for_window( $purpose, $window, $salt );
	}

	/** Accept only the current or immediately previous window for one purpose. */
	public static function validate( string $purpose, string $token, int $now, string $salt ): bool {
		self::require_inputs( $purpose, $salt );
		$window   = (int) \floor( $now / self::WINDOW_S );
		$current  = self::for_window( $purpose, $window, $salt );
		$previous = self::for_window( $purpose, $window - 1, $salt );
		return \hash_equals( $current, $token ) || \hash_equals( $previous, $token );
	}

	private static function for_window( string $purpose, int $window, string $salt ): string {
		return \hash_hmac( 'sha256', "newspack_nodes_{$purpose}:{$window}", $salt );
	}

	private static function require_inputs( string $purpose, string $salt ): void {
		if ( '' === $purpose || '' === $salt ) {
			throw new \InvalidArgumentException( 'Internal request tokens require a purpose and salt' );
		}
	}
}
