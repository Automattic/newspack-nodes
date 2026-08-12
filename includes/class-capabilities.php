<?php
/**
 * Capabilities
 *
 * The substrate's capability model: two roles — `read` (dashboards, SSE,
 * introspection verbs) and `manage` (everything that mutates) — resolved
 * through ONE filterable map. Both default to `manage_options`, so nothing
 * changes until a site filters `read` down to a lesser WP capability:
 *
 *   add_filter( 'newspack_nodes/capability_map',
 *       fn ( $map ) => [ 'read' => 'edit_posts' ] + $map );
 *
 * Verbs declare their role in node_schema() (`'capability' => 'read'`,
 * default manage); Service_CI_Node wraps every handler with the declared
 * role. Endpoints call require()/can() directly.
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
	public const MANAGE = 'manage';

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

	/** Whether the current user holds the role — false outside a WP runtime. */
	public static function can( string $role ): bool {
		return \function_exists( 'current_user_can' ) && \current_user_can( self::cap_for( $role ) );
	}

	/**
	 * Resolve a role to its WP capability through the filterable map.
	 *
	 * @param string $role One of READ|MANAGE.
	 * @throws \InvalidArgumentException On a role the map does not name (typos stay loud).
	 */
	public static function cap_for( string $role ): string {
		$defaults = [
			self::READ   => 'manage_options',
			self::MANAGE => 'manage_options',
		];
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
}
