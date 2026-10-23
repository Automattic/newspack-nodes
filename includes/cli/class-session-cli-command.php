<?php
/**
 * Session_CLI_Command: `wp nodes session issue|list|revoke`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Issue, list and revoke the labelled command sessions and the OAuth
 * connections the Sessions tab shows, through the same calls its `sessions`
 * CI makes, and revoke every session and connection at once through
 * `Sessions::revoke_all()`, which the tab lacks.
 *
 * Registered as the `nodes session` group, so each public method is a
 * subcommand; a public instance method added here would list as one too.
 */
class Session_CLI_Command {

	/**
	 * List the live issued sessions, then the OAuth connections, each newest
	 * first: id, kind, label, client, role, and when it was minted or
	 * approved and expires. Never a key or a token.
	 *
	 * The id — a session's handle, a connection's grant — is what `wp nodes
	 * session revoke` takes. A connection's label is the name its approver
	 * gave it and its client the name the client registered; it is listed
	 * whether or not it holds a live session. A session whose key no longer
	 * resolves — lapsed, revoked or flushed — is not listed, nor is a
	 * connection that has ended. Each is read from its row in the session
	 * store. The table prints times in UTC; `--format=json` keeps them as
	 * Unix timestamps.
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
			CLI::print_rows( $assoc_args, self::rows(), [ 'id', 'kind', 'label', 'client', 'scope', 'created', 'expires' ], self::readable( ... ) );
		} catch ( Session_Store_Unavailable $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}

	/**
	 * A listed row as the table prints it: times in UTC, and the label and
	 * client, which an outside caller may have named, with every control
	 * character rendered visible so none drives the operator's terminal.
	 *
	 * @param array<string,mixed> $row A `rows()` row.
	 * @return array<string,mixed>
	 */
	private static function readable( array $row ): array {
		return \array_replace( $row, [
			'label'   => Core::terminal_safe( Core::as_string( $row['label'] ) ),
			'client'  => Core::terminal_safe( Core::as_string( $row['client'] ) ),
			'created' => Core::format_utc( Core::as_int( $row['created'] ) ),
			'expires' => Core::format_utc( Core::as_int( $row['expires'] ) ),
		] );
	}

	/**
	 * The sessions, then the connections, as one set of rows.
	 *
	 * @return list<array<string,mixed>>
	 * @throws Session_Store_Unavailable When the store will not open or answer.
	 */
	private static function rows(): array {
		$rows = [];
		foreach ( Sessions::listing() as $session ) {
			$rows[] = [
				'id'      => $session['handle'],
				'kind'    => 'session',
				'label'   => $session['label'],
				'client'  => '',
				'scope'   => $session['scope'],
				'created' => $session['created'],
				'expires' => $session['expires'],
			];
		}
		foreach ( Oauth_Store::grants() as $connection ) {
			$rows[] = [
				'id'      => $connection['grant'],
				'kind'    => 'connection',
				'label'   => $connection['name'],
				'client'  => $connection['client'],
				'scope'   => $connection['scope'],
				'created' => $connection['created'],
				'expires' => $connection['expires'],
			];
		}
		return $rows;
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
	 * : read or tune. Defaults to tune.
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
		$role    = $args[1] ?? Capabilities::TUNE;
		$ttl     = isset( $args[2] ) ? ( Core::canonical_decimal( $args[2] ) ?? 0 ) : Command_Auth::SESSION_TTL_S;
		$highest = Capabilities::highest_held();
		$refusal = match ( true ) {
			'' === $label => 'usage: wp nodes session issue <label> [<role>] [<ttl>]; the label is what the Sessions tab lists',
			! \in_array( $role, Capabilities::LABELLED_SCOPES, true ) => "unknown role: {$role}; use " . \implode( ' or ', Capabilities::LABELLED_SCOPES ),
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
	 * Revoke a session by its handle, a connection by its grant id, or every
	 * session and connection with `--all`, so the keys stop verifying at once.
	 *
	 * Revoking a connection ends its grant, so it refreshes no more, and every
	 * session it minted. A label is not an id: naming one revokes nothing and
	 * fails, naming the handles of every session that carries it. Fails, too,
	 * when no session or connection holds the id, or when the session store
	 * did not answer and the key may still verify. `--all` flushes the session
	 * store, labelled and unlabelled sessions and every connection alike, and
	 * fails naming why the store refused.
	 *
	 * ## OPTIONS
	 *
	 * [<id>]
	 * : The session's handle or the connection's grant, as `wp nodes session list` prints it.
	 *
	 * [--all]
	 * : Revoke every session and connection this site issued instead.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes session revoke 0f3c9a…
	 *     wp nodes session revoke --all
	 *
	 * @api WP-CLI subcommand `wp nodes session revoke` — invoked by WP-CLI via reflection, not called in PHP.
	 * @param list<string>        $args       The id.
	 * @param array<string,mixed> $assoc_args `--all`.
	 */
	public function revoke( array $args, array $assoc_args ): void {
		$all = ! empty( $assoc_args['all'] );
		$id  = $args[0] ?? null;
		if ( $all === ( null !== $id ) ) {
			\WP_CLI::error( $all ? 'name an id or pass --all, not both' : 'name an id or pass --all' );
		}
		try {
			if ( null === $id ) {
				Sessions::revoke_all();
				\WP_CLI::success( 'Revoked every session and connection.' );
				return;
			}
			Sessions::revoke( $id );
			\WP_CLI::success( "Revoked {$id}." );
		} catch ( \RuntimeException $e ) {
			\WP_CLI::error( $e->getMessage() );
		}
	}
}
