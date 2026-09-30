<?php
/**
 * Sessions_CI: the command surface for the command sessions this site ISSUES.
 *
 * Vault's mirror. Vault stores the credentials this site sends out; this
 * lists, issues and revokes the ones it hands to callers coming in — an
 * agent's MCP client, a script on a laptop. The two share a shape and diverge
 * three ways:
 *
 *   - A listing needs an index. The session Table reads rows by handle and
 *     never scans, so each labelled session's handle is a member of one set
 *     in that Table, and `Sessions::listing()` reads the set, then the rows.
 *   - Nothing is hashed. Verification recomputes an HMAC, so the key must stay
 *     recoverable, and "show once, keep a digest" is unavailable. That is the
 *     argument for short TTLs, not for a year-long token.
 *   - A session carries a SCOPE, clamped at mint to what the issuing user
 *     holds, so a listed scope states authority rather than a request.
 *
 * Every verb is `manage`: issuing a session hands out access, the same
 * boundary that keeps the vault at manage.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Sessions;

\defined( 'ABSPATH' ) || exit;

/**
 * The `list`, `create` and `revoke` verbs over `Sessions` and `Command_Auth`,
 * each declared once in `node_schema()` and gated there by `Service_CI_Node`.
 */
class Sessions_CI_Node extends Service_CI_Node {

	/**
	 * `list` verb handler — `Sessions::listing()`, newest first, never the keys.
	 *
	 * `ttl_max` and `scopes` ride along so the Sessions tab draws its TTL bound
	 * and its scope picker from the substrate's own constants; a second copy
	 * in JavaScript drifts into offering a scope the mint refuses.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_list(): array {
		return [
			'sessions' => Sessions::listing(),
			'ttl_max'  => Command_Auth::SESSION_TTL_MAX_S,
			'scopes'   => [ Capabilities::READ, Capabilities::TUNE, Capabilities::MANAGE ],
		];
	}

	/**
	 * `create` verb handler — `create [<label>] [<scope>] [<ttl>]`, each by
	 * position or by name.
	 *
	 * The response is the ONLY place the key is ever disclosed.
	 *
	 * The requested scope is a ceiling rather than a grant. It is tested for
	 * membership on the ladder, then clamped by `Capabilities::highest_held()`
	 * to what the issuing user actually holds, so an editor asking for `manage`
	 * receives a session that says `read`. A scope off the ladder is a typo and
	 * is refused, because clamping a misspelling would hand back a working key
	 * under a scope nobody asked for. The ttl is clamped to the session bounds.
	 *
	 * An empty label still mints a working session, and `Sessions::issue()`
	 * declines to list it: the automatic `/auth` mints are unlabelled, and
	 * listing those buries the sessions an operator issued on purpose.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments: label, scope, ttl.
	 * @return array<string,mixed> The mint — handle, secret, scope, expires_in, now — plus the label.
	 * @throws \RuntimeException On a scope off the ladder, or a user holding none of the three roles.
	 * @throws \Newspack_Nodes\Session_Store_Unavailable When the store cannot hold the session; the reply names why.
	 */
	public static function cmd_create( array $args ): array {
		$label = Core::as_string( $args['label'] );
		$scope = Core::as_string( $args['scope'] );
		if ( ! Capabilities::scope_covers( $scope, Capabilities::READ ) ) {
			throw new \RuntimeException( \esc_html( "unknown session scope: {$scope}" ) );
		}

		$granted = Capabilities::highest_held( $scope );
		if ( null === $granted ) {
			throw new \RuntimeException( 'no capability to mint a session with' );
		}
		return Sessions::issue( $label, $granted, Command_Auth::bounded_ttl( Core::as_int( $args['ttl'] ) ) ) + [ 'label' => $label ];
	}

	/**
	 * `revoke` verb handler — `revoke <handle>`, through `Sessions::revoke()`,
	 * which refuses when the store did not answer or the handle named nothing.
	 *
	 * @param array<array-key,mixed> $args Bound verb arguments: handle.
	 * @return array<string,mixed> The handle, and `revoked`.
	 * @throws \RuntimeException When the store did not answer, or no session held the handle.
	 */
	public static function cmd_revoke( array $args ): array {
		$handle = Core::as_string( $args['handle'] );
		Sessions::revoke( $handle );
		return [
			'handle'  => $handle,
			'revoked' => true,
		];
	}

	/**
	 * Canvas and command metadata: the three verbs, each declared once.
	 *
	 * `Service_CI_Node` builds both the dispatch table and the capability gate
	 * from this array, so declaring a verb here registers it, documents it in
	 * `help` and gates it in one place. Every `capability` is MANAGE, because
	 * issuing a session hands out access. `Service` replaces the interpreter's
	 * inherited `Hidden` category, which is what lists the class in the console
	 * palette beside the other service CIs.
	 *
	 * `arguments` is empty: `make_node` hands this node nothing, and the
	 * per-verb `args` are what the console renders.
	 *
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
					'description' => 'Issue a session: `create [<label>] [<scope>] [<ttl>]`, each by position or as `--name=value`; scope is read, tune or manage. The key is shown once.',
					'capability'  => Capabilities::MANAGE,
					'args'        => [
						[ 'name' => 'label', 'type' => 'string', 'required' => false ],
						[ 'name' => 'scope', 'type' => 'string', 'required' => false, 'default' => Capabilities::MANAGE ],
						[ 'name' => 'ttl', 'type' => 'int', 'required' => false, 'default' => Command_Auth::SESSION_TTL_S ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_create( $args ),
				],
				[
					'name'        => 'revoke',
					'description' => 'Revoke a session by handle; its key stops verifying immediately.',
					'capability'  => Capabilities::MANAGE,
					'args'        => [ [ 'name' => 'handle', 'type' => 'string', 'required' => true ] ],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::cmd_revoke( $args ),
				],
			],
		] );
	}
}
