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
 * scope, user, label and when it was minted, and its expiry belongs to the row.
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

	/** C0 controls and DEL, and C1 controls as UTF-8 encodes them. */
	private const CONTROL_CHARS = '/[\x00-\x1F\x7F]|\xC2[\x80-\x9F]/';

	/**
	 * Revoke the session `$id` names, so its key stops verifying at once, or
	 * else the OAuth connection: its grant and every session it minted. A
	 * session a grant minted takes its grant first too, so no refresh mints
	 * another.
	 *
	 * A store that did not answer is refused, because the key may still
	 * verify. An id that named neither is refused too, and the refusal
	 * names the handles of any session LABELLED with it, newest first, which
	 * is what an operator reading the Sessions tab types; a label revokes
	 * nothing. The index keeps the handle until it lapses, and the listing
	 * skips it.
	 *
	 * @param string $id Session handle or grant id.
	 * @throws \RuntimeException When the store did not answer, or no session or grant held the id.
	 * @throws Session_Store_Unavailable When the store will not open or answer a read.
	 */
	public static function revoke( string $id ): void {
		$grant = Command_Auth::load_session_records( [ $id ] )[ $id ]['grant'] ?? null;
		if ( null !== $grant ) {
			Oauth_Store::revoke_grant( $grant );
		}
		$revoked = Command_Auth::revoke_session( $id );
		if ( null === $revoked ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for CLI and CI consumers.
			throw new \RuntimeException( "session store did not answer; {$id} may still be live" );
		}
		if ( $revoked || null !== $grant ) {
			return;
		}
		if ( null !== Oauth_Store::grant( $id ) ) {
			Oauth_Store::revoke_grant( $id );
			return;
		}
		$labelled = \array_column( \array_filter( self::listing(), static fn ( array $row ): bool => $row['label'] === $id ), 'handle' );
		$hint     = [] === $labelled ? '' : "; the label {$id} names " . \implode( ', ', $labelled );
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for CLI and CI consumers.
		throw new \RuntimeException( "no session or connection with id {$id}{$hint}" );
	}

	/**
	 * The live labelled sessions, newest first, never the key: the index,
	 * then every row it names in one read, each row's label, scope and
	 * creation read from the row and its expiry from the row's own.
	 *
	 * The index is read up to `Table_Node::MAX_MEMBERS_LIMIT` handles, live
	 * or revoked and not yet lapsed. Past that the listing refuses, naming the
	 * `revoke --all` that clears it; a labelled mint is never refused for the count.
	 *
	 * @return list<array{handle:string,label:string,scope:string,created:int,expires:int}>
	 * @throws Session_Store_Unavailable When the store will not open or answer,
	 *                                   or the index holds more than it reads.
	 */
	public static function listing(): array {
		$now  = (int) Core::right_now();
		$rows = [];
		foreach ( Command_Auth::load_session_records( \array_map( 'strval', \array_keys( Command_Auth::session_members( self::INDEX ) ) ) ) as $handle => $session ) {
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
	 * The label goes through `clean_label()` first. An empty one — the
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
		$label   = self::clean_label( $label );
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

	/**
	 * A name someone typed, made fit to keep and list: sanitized, stripped of
	 * every C0 and C1 control character and DEL, which `sanitize_text_field()`
	 * keeps and a terminal listing the name would act on, then cut to
	 * MAX_LABEL bytes on a character boundary, so it stays UTF-8.
	 *
	 * @api `Oauth_Store` keeps a client's name through it.
	 * @param string $label The name as given.
	 * @return string The name as stored; empty when nothing survives.
	 */
	public static function clean_label( string $label ): string {
		$plain = \preg_replace( self::CONTROL_CHARS, '', \sanitize_text_field( $label ) ) ?? '';
		return \mb_strcut( \trim( $plain ), 0, self::MAX_LABEL, 'UTF-8' );
	}

	/**
	 * Revoke every session this site issued, labelled or not, by flushing the
	 * session Table, which empties the labelled index with the rows.
	 *
	 * @throws \RuntimeException Naming why the store would not open or flush.
	 */
	public static function revoke_all(): void {
		Command_Auth::session_table()->flush();
	}
}
