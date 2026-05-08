<?php
/**
 * Supervisor: concrete with HMAC spawn token + spawn rate limit.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Supervisor extends SupervisorBase {
	public const TOKEN_WINDOW_S = 10;

	private string $nonce_salt;

	public function __construct( string $base_dir, string $nonce_salt ) {
		parent::__construct( $base_dir );
		$this->nonce_salt = $nonce_salt;
	}

	public function generate_spawn_token( int $now ): string {
		$window = (int) \floor( $now / self::TOKEN_WINDOW_S );
		return \hash_hmac( 'sha256', "newspack_nodes_spawn:{$window}", $this->nonce_salt );
	}

	public function validate_spawn_token( string $token, int $now ): bool {
		$window   = (int) \floor( $now / self::TOKEN_WINDOW_S );
		$current  = \hash_hmac( 'sha256', "newspack_nodes_spawn:{$window}", $this->nonce_salt );
		$previous = \hash_hmac( 'sha256', "newspack_nodes_spawn:" . ( $window - 1 ), $this->nonce_salt );
		return \hash_equals( $current, $token ) || \hash_equals( $previous, $token );
	}
}
