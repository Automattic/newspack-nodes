<?php
/**
 * Capabilities
 *
 * The substrate's capability model: three roles cut by BLAST RADIUS — `read`
 * (dashboards, SSE, introspection verbs), `tune` (declared configuration and
 * application data, bounded by a schema) and `manage` (fleet control and
 * credentials) — resolved through ONE filterable map. All three default to
 * `manage_options`, so the cut is descriptive until a site filters one down or
 * runs `wp nodes caps install`, which swaps that baseline for the three
 * granular capabilities `Roles` declares:
 *
 *   add_filter( 'newspack_nodes/capability_map',
 *       fn ( $map ) => [ 'read' => 'edit_posts' ] + $map );
 *
 * Verbs declare their role in `node_schema()` (`'capability' => 'read'`,
 * default manage), and `Service_CI_Node` wraps every handler in `require()`
 * for the role declared. The base interpreter's own vocabulary declares
 * nothing, so `Command_Interpreter_Node::dispatch()` gates it against the
 * `required_capability` floor an endpoint pins on the node instead — except
 * the read-only builtins it lists in `READ_VERBS`, which answer READ under
 * any floor. REST permission callbacks call `can()`.
 *
 * `$session_scope` is the second half: a scoped command session lowers the
 * CEILING for ONE command, which `Command_Interpreter_Node::interpret()`
 * restores around every dispatch. It can only subtract — the map still has to
 * say yes — so a scope is never a way to gain authority the authenticated
 * user lacks.
 *
 * Know what you grant: `read` is not just the shaped dashboards. It reaches
 * the RAW log firehose — request URLs, hooks, payloads — live on the SSE
 * stream beside worker IPC and REPL output, and record by record through
 * `Raw_Logs_CI_Node`'s `read_message` verb. The map is fully trusted too: a
 * filter can LOWER `manage` below manage_options, and there is no floor.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Role resolution and the per-command scope ceiling.
 */
class Capabilities {

	/** Dashboards, the SSE streams, and read-only introspection verbs. */
	public const READ = 'read';

	/** Declared configuration and application data: settings, saved layouts. */
	public const TUNE = 'tune';

	/** Fleet control, the credential vault, and issuing command sessions. */
	public const MANAGE = 'manage';

	/**
	 * A scope covering nothing. Deliberately off the ladder: `Command_Auth`
	 * installs it on every refused verification, so a command whose authority
	 * never resolved cannot leave a wider ceiling standing behind it.
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
	 * Scope ceiling for the command being handled, or null for none.
	 * `Command_Auth` writes all three states: the session's scope when a handle
	 * resolves to a live session, null for the per-site secret because the
	 * site's own authority carries no ceiling, and NONE on any refusal.
	 * `interpret()` restores what stood before, so one command's ceiling never
	 * outlives it. A ceiling only subtracts; see the file docblock.
	 *
	 * @var string|null
	 */
	public static ?string $session_scope = null;

	/**
	 * Authorisation gate: throw unless the current user holds the role.
	 * `Command_Interpreter_Node::interpret()` catches and wraps the refusal as
	 * TM_COMMAND|TM_ERROR.
	 *
	 * @param string $role One of READ|TUNE|MANAGE.
	 * @throws \RuntimeException When the current user lacks the role's capability.
	 * @throws \InvalidArgumentException Through `cap_for()`, on a role the map does not name.
	 */
	public static function require( string $role ): void {
		if ( ! self::can( $role ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \RuntimeException( "permission denied: {$role} capability required" );
		}
	}

	/**
	 * The highest role the current user holds, capped at $ceiling — which
	 * defaults to MANAGE and therefore caps nothing. Null when they hold none of
	 * the three, which is a refusal rather than an empty scope, and null for a
	 * $ceiling off the ladder, which covers nothing at all.
	 *
	 * This is how a requested session scope is clamped: asking for `manage`
	 * while holding only `read` yields `read`, so a listed scope states what a
	 * session can do rather than what it wanted. An active `$session_scope`
	 * narrows the answer through `can()`, so a scoped session cannot mint a
	 * wider one.
	 *
	 * @param string $ceiling Requested scope; every role above it is skipped.
	 * @return string|null One of READ|TUNE|MANAGE, or null for a refusal.
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
	 * false when an active session scope does not cover it. The scope is tested
	 * first, so under one an unnamed role is refused where it would otherwise
	 * throw through `cap_for()`.
	 *
	 * @param string $role One of READ|TUNE|MANAGE.
	 * @return bool True when the user holds the role's capability.
	 * @throws \InvalidArgumentException Through `cap_for()`, on a role the map does not name.
	 */
	public static function can( string $role ): bool {
		if ( null !== self::$session_scope && ! self::scope_covers( self::$session_scope, $role ) ) {
			return false;
		}
		return \function_exists( 'current_user_can' ) && \current_user_can( self::cap_for( $role ) );
	}

	/**
	 * Resolve a role to its WP capability through the filterable map, whose
	 * baseline is `Roles::defaults()`. Typos stay loud, and so does a broken
	 * filter: an unnamed role, an empty capability and a filter that returned
	 * anything but an array all throw rather than resolving to something.
	 *
	 * @param string $role One of READ|TUNE|MANAGE.
	 * @return string The capability `current_user_can()` is asked for.
	 * @throws \InvalidArgumentException When the map names no capability for the role.
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
	 * Whether $scope admits $role. An unrecognised scope or role covers nothing,
	 * so NONE, a typo and a forged string all refuse everything rather than
	 * defaulting open.
	 *
	 * @param string $scope Ceiling to test.
	 * @param string $role  Role the caller wants.
	 * @return bool True when $scope sits at or above $role on the ladder.
	 */
	public static function scope_covers( string $scope, string $role ): bool {
		$held = \array_search( $scope, self::LADDER, true );
		$want = \array_search( $role, self::LADDER, true );
		return false !== $held && false !== $want && $held >= $want;
	}
}
