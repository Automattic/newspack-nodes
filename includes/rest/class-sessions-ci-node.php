<?php
/**
 * Sessions_CI: command-dispatch for the command sessions this site ISSUES.
 *
 * Vault's mirror. Vault stores credentials for connections this site makes
 * out; this lists, issues and revokes the ones handed to callers coming in —
 * an agent's MCP client, a script on a laptop. Same shape, three deliberate
 * divergences forced by what is already true:
 *
 *   - An index is required. `Command_Auth` writes keys into a cache, and cache
 *     stores do not enumerate, so `Sessions` keeps the durable directory while
 *     the cache stays the authority on liveness.
 *   - No hash-only storage. Verification recomputes an HMAC, so the key must
 *     stay recoverable; "show once, keep a digest" is unavailable. That is the
 *     argument for short TTLs, not for a year-long token.
 *   - A session carries a SCOPE, clamped at mint to what the issuing user
 *     holds — so a listed scope states authority rather than a request.
 *
 * Every verb is `manage`: issuing one hands out access, which is the same
 * boundary that keeps the vault at manage.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Sessions;

\defined( 'ABSPATH' ) || exit;

class Sessions_CI_Node extends Service_CI_Node {

	/**
	 * `list` verb handler — the directory, newest first, never the keys.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_list(): array {
		$rows = [];
		foreach ( Sessions::all() as $handle => $row ) {
			$rows[] = [ 'handle' => $handle ] + $row;
		}
		return [
			'sessions' => $rows,
			'ttl_max'  => Command_Auth::SESSION_TTL_MAX_S,
			'scopes'   => [ Capabilities::READ, Capabilities::TUNE, Capabilities::MANAGE ],
		];
	}

	/**
	 * `create` verb handler — `create <label> [--scope=read|tune|manage] [--ttl=<seconds>]`.
	 *
	 * The response is the ONLY place the key is ever disclosed.
	 *
	 * @param list<string> $args Verb arguments.
	 * @return array<string,mixed>
	 */
	public static function cmd_create( array $args ): array {
		$parsed = Command_Args::parse( $args );
		$label  = Core::as_string( $parsed['positional'][0] ?? '' );
		$scope  = Core::as_string( $parsed['options']['scope'] ?? '', Capabilities::MANAGE );
		if ( '' === $scope ) {
			$scope = Capabilities::MANAGE;
		}
		if ( ! Capabilities::scope_covers( $scope, Capabilities::READ ) ) {
			throw new \RuntimeException( \esc_html( "unknown session scope: {$scope}" ) );
		}

		$granted = Capabilities::highest_held( $scope );
		if ( null === $granted ) {
			throw new \RuntimeException( 'no capability to mint a session with' );
		}
		// A credential lifetime is the last thing to guess at from `--ttl=1h`.
		$ttl     = Command_Auth::bounded_ttl(
			self::require_option_int( $parsed['options'], 'ttl', Command_Auth::SESSION_TTL_S, false )
		);
		$session = Command_Auth::mint_session( $granted, $ttl );
		Sessions::record( $session['handle'], $granted, $label, $ttl );
		return $session + [ 'label' => $label ];
	}

	/**
	 * `revoke` verb handler — `revoke <handle>`. Drops the lease first, so a
	 * half-failure leaves a dead listed row rather than a live unlisted key.
	 *
	 * @param list<string> $args Verb arguments.
	 * @return array<string,mixed>
	 */
	public static function cmd_revoke( array $args ): array {
		$handle = Core::as_string( Command_Args::parse( $args )['positional'][0] ?? '' );
		if ( '' === $handle ) {
			throw new \RuntimeException( 'handle required' );
		}
		Sessions::forget( $handle );
		return [
			'handle'  => $handle,
			'revoked' => true,
		];
	}

	/**
	 * @api Used by substrate.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Command sessions this site has issued: list, create, revoke.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'list',
					'description' => 'Issued sessions, newest first, with liveness. Never the keys.',
					'capability'  => Capabilities::MANAGE,
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args = [], array $envelope = [] ): array => self::cmd_list(),
				],
				[
					'name'        => 'create',
					'description' => 'Issue a session: `create <label> [--scope=read|tune|manage] [--ttl=<seconds>]`. The key is shown once.',
					'capability'  => Capabilities::MANAGE,
					'args'        => [
						[ 'name' => 'label', 'type' => 'string', 'required' => false ],
						[ 'name' => 'scope', 'type' => 'string', 'required' => false, 'default' => Capabilities::MANAGE ],
						[ 'name' => 'ttl', 'type' => 'int', 'required' => false, 'default' => Command_Auth::SESSION_TTL_S ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args = [], array $envelope = [] ): array => self::cmd_create( self::arg_strings( $args ) ),
				],
				[
					'name'        => 'revoke',
					'description' => 'Revoke a session by handle; its key stops verifying immediately.',
					'capability'  => Capabilities::MANAGE,
					'args'        => [ [ 'name' => 'handle', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args = [], array $envelope = [] ): array => self::cmd_revoke( self::arg_strings( $args ) ),
				],
			],
		] );
	}
}
