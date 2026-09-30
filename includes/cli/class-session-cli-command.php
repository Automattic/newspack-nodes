<?php
/**
 * Session_CLI_Command: `wp nodes session issue`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Mint a labelled command session and print it as a Bearer credential.
 *
 * Registered as the `nodes session` group, so each public method is a
 * subcommand; a public instance method added here would list as one too.
 */
class Session_CLI_Command {

	/**
	 * Issue a session and print `<handle>.<secret>` on stdout, and nothing else.
	 *
	 * The output is the Bearer credential the MCP endpoint parses, so `$( … )`
	 * captures it whole. The session acts as the WP-CLI user (`--user=<login>`),
	 * carries the label in the Sessions tab, where it can be revoked, and
	 * expires after the TTL. A role the user does not hold is refused, not
	 * lowered.
	 *
	 * ## OPTIONS
	 *
	 * <label>
	 * : Name shown in the Sessions tab.
	 *
	 * [<role>]
	 * : read, tune or manage. Defaults to manage.
	 *
	 * [<ttl>]
	 * : Lifetime in seconds, 60 to 86400. Defaults to 3600.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes session issue chris-claude tune 86400 --user=chris
	 *
	 * @api WP-CLI subcommand `wp nodes session issue` — invoked by WP-CLI via reflection, not called in PHP.
	 * @param list<string>        $args       Label, then optionally the role and the TTL.
	 * @param array<string,mixed> $assoc_args Unused.
	 */
	public function issue( array $args, array $assoc_args ): void {
		$label   = \trim( $args[0] ?? '' );
		$role    = $args[1] ?? Capabilities::MANAGE;
		$ttl     = isset( $args[2] ) ? ( Core::canonical_decimal( $args[2] ) ?? 0 ) : Command_Auth::SESSION_TTL_S;
		$highest = Capabilities::highest_held();
		$refusal = match ( true ) {
			'' === $label => 'usage: wp nodes session issue <label> [<role>] [<ttl>]; the label is what the Sessions tab lists',
			! Capabilities::scope_covers( $role, Capabilities::READ ) => "unknown role: {$role}; use read, tune or manage",
			$ttl < Command_Auth::SESSION_TTL_MIN_S || $ttl > Command_Auth::SESSION_TTL_MAX_S => 'ttl must be whole seconds from ' . Command_Auth::SESSION_TTL_MIN_S . ' to ' . Command_Auth::SESSION_TTL_MAX_S . ', got ' . ( $args[2] ?? '' ),
			0 === \get_current_user_id() => 'a session acts as the user who mints it; pass --user=<login>',
			null === $highest => 'that user holds no Newspack Nodes role',
			! Capabilities::scope_covers( $highest, $role ) => "that user holds at most {$highest}, not {$role}",
			default => null,
		};
		if ( null !== $refusal ) {
			\WP_CLI::error( $refusal );
			// The real error() exits; a stub returning must not fall through.
			throw new \RuntimeException( \esc_html( $refusal ) );
		}

		try {
			$session = Command_Auth::mint_session( $role, $ttl );
			Sessions::record( $session['handle'], $role, $label, $ttl );
			\WP_CLI::line( "{$session['handle']}.{$session['secret']}" );
		} catch ( Session_Store_Unavailable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}
}
