<?php
/**
 * PHPStan bootstrap stub.
 *
 * WordPress derives NONCE_SALT (and the other auth salts) from wp-config.php at
 * runtime, so they are NOT among the core constants szepeviktor/phpstan-wordpress
 * stubs. Bootstrap::spawn_coordinator() passes NONCE_SALT to Supervisor for HMAC; define
 * a stub value here so static analysis resolves the constant. Excluded from the
 * release zip via .distignore (`.phpstan`).
 *
 * @package Newspack_Nodes
 */

if ( ! \defined( 'NONCE_SALT' ) ) {
	\define( 'NONCE_SALT', 'phpstan-stub-nonce-salt' );
}
