<?php
/**
 * Capabilities
 *
 * The substrate's capability model: three roles cut by BLAST RADIUS — `read`
 * (dashboards, SSE, introspection commands), `tune` (declared configuration and
 * application data, bounded by a schema) and `manage` (fleet control and
 * credentials) — resolved through ONE filterable map. All three default to
 * `manage_options`, so the cut is descriptive until a site filters one down or
 * runs `wp nodes caps install`, which swaps that baseline for the three
 * granular capabilities `Roles` declares:
 *
 *   add_filter( 'newspack_nodes/capability_map',
 *       fn ( $map ) => [ 'read' => 'edit_posts' ] + $map );
 *
 * Commands declare their role in `node_schema()` (`'capability' => 'read'`,
 * default manage) — a service CI in its own schema, a `:config` interpreter in its
 * patron's schema — and `Command_Interpreter_Node::dispatch()` refuses every command
 * through `require_command()` against the role declared (ADR-26). The base
 * interpreter's own vocabulary declares nothing, so it demands MANAGE, except
 * the read-only commands `READ_VERBS` lists, which answer READ. REST
 * permission callbacks call `can()`.
 *
 * A command may declare a WordPress capability in place of a role,
 * `'capability' => 'wp:edit_posts'`, for an editor who holds no role. The
 * signed-in user's own `current_user_can()` decides it: no session ceiling
 * and no `allowed_users` list narrows it, a worker refuses it for want of a
 * user, and `can()` never admits it, so no MCP door lists one.
 *
 * `$session_scope` is the second half: a scoped command session lowers the
 * CEILING for ONE command, which `Command_Interpreter_Node::interpret()`
 * restores around every dispatch. It can only subtract — the map still has to
 * say yes — so a scope is never a way to gain authority the authenticated
 * user lacks.
 *
 * The operator's `allowed_users` list is the third half, and it narrows every
 * role rather than the admin menus alone: a login absent from a populated list
 * holds no role, so both SSE streams, the spawn endpoint's external path and
 * every role-declared command refuse it, and `/auth` issues it a `none`
 * session. It applies to an authenticated actor only — see
 * `allowed_by_operator_list()`.
 *
 * Know what you grant: `read` is not just the shaped dashboards. It reaches
 * the RAW log firehose — request URLs, hooks, payloads — live on the SSE
 * stream beside worker IPC and REPL output, and record by record through
 * `Raw_Logs_CI_Node`'s `read_message` and `read_block` commands, for every log
 * whose dir carries no read-capability marker (ADR-39). The
 * map is fully trusted too: a filter can LOWER `manage` below
 * manage_options, and there is no floor.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Role resolution and the per-command scope ceiling.
 */
class Capabilities {

	/** Dashboards, the SSE streams, and read-only introspection commands. */
	public const READ = 'read';

	/** Declared configuration and application data: settings, saved layouts. */
	public const TUNE = 'tune';

	/** Fleet control, the credential vault, and issuing command sessions. */
	public const MANAGE = 'manage';

	/** A WordPress capability name: lowercase letters, digits and underscores. */
	public const NAME_PATTERN = '/^[a-z0-9_]+$/D';

	/**
	 * Opens a command's declared `capability` that names a WordPress
	 * capability rather than a role: `wp:edit_posts`. The signed-in user's
	 * own `current_user_can()` decides it, off the ladder, so no session
	 * ceiling and no `allowed_users` list narrows it; it runs only under an
	 * unlabelled session or none at all, so a labelled CLI, MCP or hub
	 * session keeps the meaning of its ceiling (ADR-26).
	 */
	public const WP_PREFIX = 'wp:';

	/**
	 * A scope covering no role. Deliberately off the ladder: `/auth` issues it,
	 * unlabelled, to a signed-in user holding none of the three roles, who may
	 * then run only the `wp:` commands their own capabilities reach. A refused
	 * verification installs `Command_Auth::UNVERIFIED` instead, a ceiling
	 * that is never granted to a session.
	 */
	public const NONE = 'none';

	/**
	 * The scopes a labelled session may hold: one a person keeps in a CLI
	 * history, an MCP client or a hub's vault. Restoring `manage` is one edit.
	 *
	 * @var list<string>
	 */
	public const LABELLED_SCOPES = [ self::READ, self::TUNE ];

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
	 * site's own authority carries no ceiling, and `Command_Auth::UNVERIFIED`
	 * on any refusal.
	 * `interpret()` restores what stood before, so one command's ceiling never
	 * outlives it. A ceiling only subtracts; see the file docblock.
	 *
	 * @var string|null
	 */
	public static ?string $session_scope = null;

	/**
	 * Label of the command session in force, which a command reads to name the
	 * caller, or null for none. Written wherever `$session_scope` is written
	 * from a session record: '' for a session minted without a label, null
	 * for the per-site secret and on any refusal. `interpret()` restores what
	 * stood before.
	 *
	 * @api A consuming plugin's command reads it.
	 * @var string|null
	 */
	public static ?string $session_label = null;

	/**
	 * Handle of the command session in force, or null for none. Written
	 * beside `$session_label`: a session's own handle, null for the per-site
	 * secret and on any refusal. `interpret()` restores what stood before.
	 *
	 * @api A consuming plugin's command reads it to tell one session of a user from another.
	 * @var string|null
	 */
	public static ?string $session_handle = null;

	/**
	 * The one authorisation gate, which `Command_Interpreter_Node::dispatch()`
	 * puts in front of every command: throw unless the command being handled may
	 * run at $role (ADR-26). `interpret()` catches and wraps the refusal as
	 * TM_COMMAND|TM_ERROR.
	 *
	 * Where a WordPress user is logged in, that is `can()`: the user's
	 * capability, under whatever ceiling the command's session installed. A
	 * worker has no logged-in user, so the ceiling alone decides, and a command
	 * carrying none — the site's own signature, a process's own line — runs at
	 * MANAGE, the authority that loaded the topology.
	 *
	 * A `wp:<capability>` declaration is the signed-in user's own
	 * `current_user_can()`, refused in a worker, which has no user, under a
	 * labelled session and on an unverified command (`refusal()`).
	 *
	 * @param string $role One of READ|TUNE|MANAGE, or `wp:<capability>`.
	 * @throws \RuntimeException When the role is refused.
	 * @throws \InvalidArgumentException Through `cap_for()`, on a role the map
	 *                                   does not name, or through `wp_capability()`.
	 */
	public static function require_command( string $role ): void {
		$denial = self::refusal( $role );
		if ( null !== $denial ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \RuntimeException( "permission denied: {$denial}" );
		}
	}

	/**
	 * Whether the command being handled may run at $role, as `refusal()`
	 * decides it. `require_command()` refuses on the same answer, and
	 * `Core::caller_message()` asks it before it lets an engine error's own
	 * words go back.
	 *
	 * @param string $role One of READ|TUNE|MANAGE, or `wp:<capability>`.
	 * @throws \InvalidArgumentException Through `cap_for()`, on a role the map
	 *                                   does not name, or through `wp_capability()`.
	 */
	public static function command_holds( string $role ): bool {
		return null === self::refusal( $role );
	}

	/**
	 * Why the command being handled may not run at $role, or null when it
	 * may. A role is the logged-in user's `can()`, else, in a worker, the
	 * session's ceiling alone, a command carrying none running at MANAGE. A
	 * `wp:` declaration needs a signed-in user, a verified command, an
	 * unlabelled session or none — a labelled session is a hand-issued key,
	 * for a CLI, an MCP client or a hub's vault, whose ceiling must keep
	 * meaning what it says — and the user's own capability.
	 *
	 * @param string $role One of READ|TUNE|MANAGE, or `wp:<capability>`.
	 * @return string|null The refusal, after `permission denied: `.
	 * @throws \InvalidArgumentException Through `cap_for()`, on a role the map
	 *                                   does not name, or through `wp_capability()`.
	 */
	private static function refusal( string $role ): ?string {
		$cap  = self::wp_capability( $role );
		$user = Core::current_user_id();
		if ( null === $cap ) {
			$holds = 0 !== $user ? self::can( $role ) : self::scope_covers( self::$session_scope ?? self::MANAGE, $role );
			return $holds ? null : "{$role} capability required";
		}
		return match ( true ) {
			0 === $user                                       => "{$cap} requires a signed-in user",
			Command_Auth::UNVERIFIED === self::$session_scope => "{$cap} requires a verified command",
			'' !== ( self::$session_label ?? '' )             => "{$cap} refuses a labelled session",
			! \current_user_can( $cap )                       => "{$cap} capability required",
			default                                           => null,
		};
	}

	/**
	 * The WordPress capability a `wp:` declaration names, or null for a role.
	 *
	 * @param string $role A declared `capability`.
	 * @return string|null The capability after `wp:`, or null without the prefix.
	 * @throws \InvalidArgumentException When the name after `wp:` is not a
	 *                                   WordPress capability (`NAME_PATTERN`).
	 */
	private static function wp_capability( string $role ): ?string {
		if ( ! \str_starts_with( $role, self::WP_PREFIX ) ) {
			return null;
		}
		$cap = \substr( $role, \strlen( self::WP_PREFIX ) );
		if ( 1 !== \preg_match( self::NAME_PATTERN, $cap ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \InvalidArgumentException( "invalid WordPress capability: '{$cap}'" );
		}
		return $cap;
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
		if ( ! \function_exists( 'current_user_can' ) || ! \current_user_can( self::cap_for( $role ) ) ) {
			return false;
		}
		return self::allowed_by_operator_list();
	}

	/**
	 * Whether the operator's `allowed_users` list admits the logged-in user.
	 * Checked AFTER the capability, so a demoted account loses authority at once
	 * and the list never has to be edited; an empty list — the shipped
	 * default — narrows nobody.
	 *
	 * The list can only narrow an AUTHENTICATED actor. With no login there is
	 * nothing to match, so the list does not apply and the capability check is
	 * the whole gate: WP-CLI without `--user`, a worker process and WP-Cron all
	 * run that way, and a populated list must not disarm the fleet.
	 *
	 * A config that will not load refuses instead of propagating. `can()` is
	 * what four REST `permission_callback`s answer with, where a throw is an
	 * uncaught 500 rather than a 403, and what `Auto_Tuner_Node::fill()` asks
	 * on the request path, where ADR-13 forbids one — so the read is caught
	 * here and reported, the same trade `Health_Checks` makes for an alert
	 * family it cannot bucket. The `\InvalidArgumentException` `cap_for()`
	 * raises on a broken capability map is a different contract and still
	 * propagates.
	 *
	 * @return bool True when the list does not apply or the current login is on
	 *              it.
	 */
	private static function allowed_by_operator_list(): bool {
		$login = \function_exists( 'wp_get_current_user' )
			? Core::as_string( \wp_get_current_user()->user_login )
			: '';
		if ( '' === $login ) {
			return true;
		}

		try {
			return ! self::operator_list_excludes( $login );
		} catch ( \RuntimeException $e ) {
			Core::print_less_often(
				'Capabilities: allowed_users unreadable, refusing every role: ',
				$e->getMessage()
			);
			return false;
		}
	}

	/**
	 * Whether a populated `allowed_users` list omits $login. The one place the
	 * list's shape is read, so `wp nodes hub-user` warns on exactly the logins
	 * `can()` will refuse — a hub account absent from a populated list answers
	 * 401 at `HTTP_In_Node::check_permission()` with nothing to say why.
	 *
	 * @param string $login A `user_login` to test against the list.
	 * @return bool True when a list is configured and does not name $login.
	 * @throws \RuntimeException Through `Config::value()`, when a config file is invalid.
	 */
	public static function operator_list_excludes( string $login ): bool {
		$allowed = Config::value( 'allowed_users' );
		if ( ! \is_array( $allowed ) ) {
			// A scalar is a config typo, never an absent list: narrow to it.
			$single  = Core::as_string( $allowed );
			$allowed = '' === $single ? [] : [ $single ];
		}
		return [] !== $allowed && ! \in_array( $login, $allowed, true );
	}

	/**
	 * Resolve a role to its WP capability through the filterable map, whose
	 * baseline is `Roles::defaults()`. Typos stay loud, and so does a broken
	 * filter: an unnamed role, an empty capability and a filter that returned
	 * anything but an array all throw rather than resolving to something.
	 *
	 * @param string $role One of READ|TUNE|MANAGE.
	 * @return string The capability `current_user_can()` is asked for.
	 * @throws \InvalidArgumentException When the map does not name a capability
	 *                                   for the role.
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

	/**
	 * A log's read capability as a topology declares it, refused unless it
	 * spells a WordPress capability: lowercase letters, digits and
	 * underscores. A Partition, a Log and a Delay refuse it at load through
	 * this one rule, and a marker on disk is read by `NAME_PATTERN` (ADR-39).
	 *
	 * @param string $cap The capability a raw read of the log needs.
	 * @return string The capability, unchanged.
	 * @throws \InvalidArgumentException On an empty or malformed name.
	 */
	public static function read_capability( string $cap ): string {
		if ( 1 !== \preg_match( self::NAME_PATTERN, $cap ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \InvalidArgumentException( "invalid read capability: '{$cap}' (want lowercase letters, digits and underscores)" );
		}
		return $cap;
	}

	/**
	 * What a role admits, in the words of the person granting it: the one
	 * wording the OAuth approval page and the Sessions tab show, so every
	 * role on the ladder carries one whether or not a surface offers it yet.
	 *
	 * @param string $role One of READ|TUNE|MANAGE.
	 * @return string The translated description.
	 * @throws \InvalidArgumentException On a role off the ladder.
	 */
	public static function label( string $role ): string {
		return match ( $role ) {
			self::READ => \__( 'See the dashboards and the logged traffic; change nothing.', 'newspack-nodes' ),
			self::TUNE => \__( 'See the dashboards and the logged traffic; change settings and application data.', 'newspack-nodes' ),
			self::MANAGE => \__( 'See and change everything, the fleet and the credential vault included.', 'newspack-nodes' ),
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			default => throw new \InvalidArgumentException( "unknown capability role: {$role}" ),
		};
	}
}
