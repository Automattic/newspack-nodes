<?php
/**
 * Session_CLI_Command: `wp nodes session issue|list|revoke`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Issue, list and revoke the labelled command sessions the Sessions tab shows,
 * through the same `Sessions` calls its `sessions` CI makes.
 *
 * Registered as the `nodes session` group, so each public method is a
 * subcommand; a public instance method added here would list as one too.
 */
class Session_CLI_Command {

	/**
	 * List the live issued sessions, newest first: handle, label, role, and
	 * when it was minted and expires. Never the key.
	 *
	 * The handle is what `wp nodes session revoke` takes. A session whose key
	 * no longer resolves — lapsed, revoked or flushed — is not listed. Each
	 * is read from its row in the session store. The table prints
	 * times in UTC; `--format=json` keeps them as Unix timestamps.
	 *
	 * ## OPTIONS
	 *
	 * [--format=<format>]
	 * : Output format.
	 * ---
	 * default: table
	 * options:
	 *   - table
	 *   - json
	 * ---
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes session list
	 *     wp nodes session list --format=json
	 *
	 * @api WP-CLI subcommand `wp nodes session list` — invoked by WP-CLI via reflection, not called in PHP.
	 * @subcommand list
	 *
	 * @param list<string>        $args       Unused.
	 * @param array<string,mixed> $assoc_args `--format`.
	 */
	public function list_( array $args, array $assoc_args ): void {
		unset( $args );
		try {
			CLI::print_rows( $assoc_args, Sessions::listing(), [ 'handle', 'label', 'scope', 'created', 'expires' ], self::readable( ... ) );
		} catch ( Session_Store_Unavailable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/**
	 * A listed row as the table prints it: times in UTC.
	 *
	 * @param array<string,mixed> $row A `Sessions::listing()` row.
	 * @return array<string,mixed>
	 */
	private static function readable( array $row ): array {
		return \array_replace( $row, [
			'created' => Core::format_utc( Core::as_int( $row['created'] ) ),
			'expires' => Core::format_utc( Core::as_int( $row['expires'] ) ),
		] );
	}

	/**
	 * Issue a session and print `<handle>.<secret>` on stdout, and nothing else.
	 *
	 * The output is the Bearer credential the MCP endpoint parses, so `$( … )`
	 * captures it whole. The session acts as the WP-CLI user (`--user=<login>`),
	 * lists under the label in the Sessions tab and `wp nodes session list`, and
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
			$session = Sessions::issue( $label, $role, $ttl );
			\WP_CLI::line( "{$session['handle']}.{$session['secret']}" );
		} catch ( Session_Store_Unavailable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/**
	 * Revoke a session by its handle, so its key stops verifying at once.
	 *
	 * A label is not a handle: naming one revokes nothing and fails, naming
	 * the handles of every session that carries it. Fails, too, when no
	 * session holds the handle, or when the session store did not answer and
	 * the key may still verify.
	 *
	 * ## OPTIONS
	 *
	 * <handle>
	 * : The session's handle, as `wp nodes session list` prints it.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes session revoke 0f3c9a…
	 *
	 * @api WP-CLI subcommand `wp nodes session revoke` — invoked by WP-CLI via reflection, not called in PHP.
	 * @param list<string>        $args       The handle.
	 * @param array<string,mixed> $assoc_args Unused.
	 */
	public function revoke( array $args, array $assoc_args ): void {
		$handle = $args[0] ?? '';
		try {
			Sessions::revoke( $handle );
			\WP_CLI::success( "Revoked {$handle}." );
		} catch ( \RuntimeException $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}
}
