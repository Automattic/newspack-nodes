<?php
/**
 * Sessions: the command sessions this site has issued under a label.
 *
 * The mirror of Vault. Vault stores credentials for connections this site
 * makes OUT; this lists the ones it hands to callers coming IN — an agent's
 * MCP client, a script on someone's laptop — so an operator can see what is
 * connected and revoke it.
 *
 * Everything lives in the session Table. A session's row carries its key,
 * scope, user, label and when it was minted, and its expiry is the row's own.
 * A labelled session's handle is also a member of one set, `INDEX`, in the
 * same Table and under the same lifetime, because a Table key-range scan is
 * rejected (ADR-24) and a set read by its key is how a durable Table
 * enumerates. A listing reads the set, then every row it names in one read,
 * and lists the rows still standing, so a lapsed, revoked or flushed session
 * leaves it with no sweep of its own.
 *
 * The signing key is never listed. It cannot be hashed either — verification
 * recomputes an HMAC, so the key must stay recoverable — which is exactly the
 * argument for short TTLs over long-lived tokens.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Static calls over `Command_Auth`'s session Table, so a web request, a worker
 * or WP-CLI reaches them without wiring a node.
 */
class Sessions {

	/** The set in the session Table whose members are the labelled handles. */
	public const INDEX = 'labelled';

	/** Longest label a session keeps, so a listing can't be used as storage. */
	public const MAX_LABEL = 64;

	/**
	 * Revoke the session `$handle` names, so its key stops verifying at once.
	 *
	 * A store that did not answer is refused, because the key may still
	 * verify. A handle that named nothing is refused too, and the refusal
	 * names the handles of any session LABELLED with it, newest first, which
	 * is what an operator reading the Sessions tab types; a label revokes
	 * nothing. The index keeps the handle until it lapses, and the listing
	 * skips it.
	 *
	 * @param string $handle Session handle.
	 * @throws \RuntimeException When the store did not answer, or no session held the handle.
	 * @throws Session_Store_Unavailable When the store will not open.
	 */
	public static function revoke( string $handle ): void {
		$revoked = Command_Auth::revoke_session( $handle );
		if ( null === $revoked ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for CLI and CI consumers.
			throw new \RuntimeException( "session store did not answer; {$handle} may still be live" );
		}
		if ( ! $revoked ) {
			$labelled = \array_column( \array_filter( self::listing(), static fn ( array $row ): bool => $row['label'] === $handle ), 'handle' );
			$hint     = [] === $labelled ? '' : "; the label {$handle} names " . \implode( ', ', $labelled );
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for CLI and CI consumers.
			throw new \RuntimeException( "no session with handle {$handle}{$hint}" );
		}
	}

	/**
	 * The live labelled sessions, newest first, never the key: the index,
	 * then every row it names in one read, each row's label, scope and
	 * creation read from the row and its expiry from the row's own.
	 *
	 * The index is read up to `Table_Node::MAX_MEMBERS_LIMIT` handles, live
	 * or revoked and not yet lapsed. Past that the listing refuses, naming the
	 * flush that clears it; a labelled mint is never refused for the count.
	 *
	 * @return list<array{handle:string,label:string,scope:string,created:int,expires:int}>
	 * @throws Session_Store_Unavailable When the store will not open or answer,
	 *                                   or the index holds more than it reads.
	 */
	public static function listing(): array {
		$table = Command_Auth::session_table();
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
		$index = $table->members_of( [ self::INDEX ], Table_Node::MAX_MEMBERS_LIMIT ) ?? throw new Session_Store_Unavailable( "could not read the session index: {$table->last_failure()}" );
		if ( \array_key_exists( self::INDEX, $index ) && null === $index[ self::INDEX ] ) {
			throw new Session_Store_Unavailable( 'more than ' . Table_Node::MAX_MEMBERS_LIMIT . ' labelled sessions are indexed; `wp nodes tables flush ' . Command_Auth::SESSIONS_TABLE . '` revokes every session' );
		}
		$now  = (int) Core::right_now();
		$rows = [];
		foreach ( Command_Auth::load_session_records( \array_map( 'strval', \array_keys( $index[ self::INDEX ] ?? [] ) ) ) as $handle => $session ) {
			$rows[] = [
				'handle'  => $handle,
				'label'   => $session['label'],
				'scope'   => $session['scope'],
				'created' => $session['created'],
				'expires' => $now + $session['ttl'],
			];
		}
		\usort( $rows, static fn ( array $a, array $b ): int => $b['created'] <=> $a['created'] );
		return $rows;
	}

	/**
	 * Mint a session and index it when it carries a label: the one issuing
	 * path, which `/auth`, the `sessions create` verb and `wp nodes session
	 * issue` share. Each caller keeps its own policy for a scope or TTL out of
	 * bounds — REST and the CI clamp, the CLI refuses — and hands this the
	 * result.
	 *
	 * The label is sanitized and cut to MAX_LABEL bytes first, on a character
	 * boundary, so the stored label stays UTF-8. An empty one — the
	 * automatic `/auth` mints, several per dashboard load — mints a working
	 * session that nothing lists, so the ones an operator issued on purpose
	 * are not buried. A session the index refuses is revoked before the
	 * refusal, so no live key goes unlisted.
	 *
	 * @param string $label Operator's name for the session.
	 * @param string $scope Capability ceiling, one of `Capabilities::READ|TUNE|MANAGE`.
	 * @param int    $ttl   Lifetime in seconds, taken as given.
	 * @return array{handle:string,secret:string,scope:string,expires_in:int,now:int} The mint, the one place the key is disclosed.
	 * @throws Session_Store_Unavailable When the store will not open, refuses the row, or refuses the index.
	 */
	public static function issue( string $label, string $scope, int $ttl ): array {
		$label   = \mb_strcut( \sanitize_text_field( $label ), 0, self::MAX_LABEL, 'UTF-8' );
		$session = Command_Auth::mint_session( $scope, $ttl, $label );
		if ( '' === $label ) {
			return $session;
		}
		$table = Command_Auth::session_table();
		if ( [] === $table->add_members( [ self::INDEX => [ [ $session['handle'] => 1 ], $ttl ] ] ) ) {
			$failure = $table->last_failure();
			Command_Auth::revoke_session( $session['handle'] );
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new Session_Store_Unavailable( "could not index the session: {$failure}" );
		}
		return $session;
	}
}
