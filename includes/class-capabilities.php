<?php
/**
 * Capabilities
 *
 * The substrate's capability model: three roles cut by BLAST RADIUS — `read`
 * (dashboards, SSE, introspection verbs), `tune` (declared configuration and
 * application data, bounded by a schema) and `manage` (fleet control and
 * credentials) — resolved through ONE filterable map. All three default to
 * `manage_options`, so nothing changes until a site filters one down:
 *
 *   add_filter( 'newspack_nodes/capability_map',
 *       fn ( $map ) => [ 'read' => 'edit_posts' ] + $map );
 *
 * Verbs declare their role in node_schema() (`'capability' => 'read'`,
 * default manage); Service_CI_Node wraps every handler with the declared
 * role. Endpoints call require()/can() directly.
 *
 * `$session_scope` is the second half: a scoped command session lowers the
 * CEILING for the rest of the request. It can only subtract — the map still
 * has to say yes — so a scope is never a way to gain authority the
 * authenticated user lacks.
 *
 * Know what you grant: the `read` role's live surface is the SSE stream —
 * the RAW log firehose (request URLs, hooks, payloads) and worker IPC/REPL
 * output — not just shaped dashboards. And the map is fully trusted: a
 * filter can also LOWER `manage` below manage_options; there is no floor.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Capabilities gate.
 */
class Capabilities {

	public const READ   = 'read';
	public const TUNE   = 'tune';
	public const MANAGE = 'manage';

	/**
	 * A scope covering nothing. Deliberately off the ladder: it is the
	 * pessimistic value a verifier installs while a command's authority is
	 * still being established, so an early refusal cannot leave a wider
	 * ceiling standing than the command that failed.
	 */
	public const NONE = 'none';

	/**
	 * The roles in ascending blast radius. Position IS the ladder: a scope
	 * covers every role at or below its own index.
	 *
	 * @var list<string>
	 */
	private const LADDER = [ self::READ, self::TUNE, self::MANAGE ];

	/**
	 * Scope ceiling for the current request, or null for none. Set by
	 * Command_Auth when a scoped session's signature verifies, and cleared on
	 * every unscoped verification, so one command's ceiling can never outlive
	 * it. A ceiling only subtracts; see the class docblock.
	 *
	 * @var string|null
	 */
	public static ?string $session_scope = null;

	/**
	 * Authorisation gate: throw unless the current user holds the role.
	 * CommandInterpreter::interpret() catches and wraps as TM_COMMAND|TM_ERROR.
	 *
	 * @throws \RuntimeException When the current user lacks the role's capability.
	 */
	public static function require( string $role ): void {
		if ( ! self::can( $role ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \RuntimeException( "permission denied: {$role} capability required" );
		}
	}

	/**
	 * The highest role the current user holds, capped at $ceiling. Null when
	 * they hold none of them — which is a refusal, not an empty scope.
	 *
	 * This is how a requested session scope is clamped: asking for `manage` as
	 * an editor yields `read`, so a listed scope states what a session can
	 * actually do rather than what it wanted.
	 */
	public static function highest_held( string $ceiling = self::MANAGE ): ?string {
		foreach ( \array_reverse( self::LADDER ) as $role ) {
			if ( self::scope_covers( $ceiling, $role ) && self::can( $role ) ) {
				return $role;
			}
		}
		return null;
	}

	/**
	 * Whether the current user holds the role — false outside a WP runtime, and
	 * false when an active session scope does not cover it.
	 */
	public static function can( string $role ): bool {
		if ( null !== self::$session_scope && ! self::scope_covers( self::$session_scope, $role ) ) {
			return false;
		}
		return \function_exists( 'current_user_can' ) && \current_user_can( self::cap_for( $role ) );
	}

	/**
	 * Resolve a role to its WP capability through the filterable map.
	 *
	 * @param string $role One of READ|TUNE|MANAGE.
	 * @throws \InvalidArgumentException On a role the map does not name (typos stay loud).
	 */
	public static function cap_for( string $role ): string {
		$defaults = Roles::defaults();
		$map = \function_exists( 'apply_filters' )
			? \apply_filters( 'newspack_nodes/capability_map', $defaults )
			: $defaults;
		$cap = Core::as_string( \is_array( $map ) ? ( $map[ $role ] ?? '' ) : '', '' );
		if ( '' === $cap ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \InvalidArgumentException( "unknown capability role: {$role}" );
		}
		return $cap;
	}

	/**
	 * Whether $scope admits $role. An unrecognised scope covers nothing, so a
	 * typo'd or forged scope string refuses everything rather than defaulting
	 * open.
	 */
	public static function scope_covers( string $scope, string $role ): bool {
		$held = \array_search( $scope, self::LADDER, true );
		$want = \array_search( $role, self::LADDER, true );
		return false !== $held && false !== $want && $held >= $want;
	}
}
