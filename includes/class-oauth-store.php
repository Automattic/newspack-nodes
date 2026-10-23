<?php
/**
 * Oauth_Store: the OAuth clients, codes, grants and refresh tokens.
 *
 * Every row lives in the session Table beside the command sessions, so
 * `Sessions::revoke_all()` and a switch of `sessions_backend` reach them with
 * no code of their own. A client, a grant and the sessions a grant minted are
 * found by id; a code, a refresh token and its spent and grace rows by the
 * SHA-256 of the secret, so the store never holds a code or a live refresh
 * token in plaintext. The one exception is the grace row: for sixty seconds
 * after a rotation it holds the answer a retried refresh is given again.
 *
 * A grant lives thirty days from approval and no use extends it: each refresh
 * token it issues lives exactly as long as the grant has left. A rotation's
 * grace row is its claim, written before the spent token's row is deleted,
 * so of two refreshes racing one token the second answers the first's pair.
 * Presenting a spent refresh token after the grace revokes the grant and
 * every session it minted. The grants are listed through the `oauth:grants`
 * set (ADR-24); `Table_Node` offers no member removal outside a graph, so a
 * revoked grant's member lapses with the grant and the listing skips it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Static calls over the session Table's OAuth rows. Every failure of the store
 * throws `Session_Store_Unavailable`.
 *
 * @api The OAuth endpoints, the grant-session mint and the Sessions verbs.
 */
final class Oauth_Store {

	/** A registered client's lifetime, from registration. */
	private const CLIENT_TTL_S = 180 * DAY_IN_SECONDS;

	/** An authorization code's lifetime; it is taken once. */
	private const CODE_TTL_S = 60;

	/** A grant's lifetime from approval, never extended. */
	private const GRANT_TTL_S = 30 * DAY_IN_SECONDS;

	/** How long after its rotation a refresh token's retry is answered again. */
	private const GRACE_S = 60;

	/** Most redirect URIs one client registers. */
	private const MAX_REDIRECT_URIS = 5;

	/** The hosts a plain-http redirect URI may name. */
	private const LOOPBACK_HOSTS = [ 'localhost', '127.0.0.1' ];

	/** The set whose members are every grant's id. */
	private const GRANTS = 'oauth:grants';

	/**
	 * Register a public client. Its name is kept as a session label is,
	 * through `Sessions::clean_label()`, because registration is open to anyone.
	 *
	 * @param string       $name          The client's self-declared name.
	 * @param array<mixed> $redirect_uris One to five URIs, each `https://` or
	 *                                    `http://` on localhost or 127.0.0.1,
	 *                                    with no userinfo, fragment or space.
	 * @return string The client id.
	 * @throws \InvalidArgumentException On an empty name, a count outside one
	 *                                   to five, or a URI neither https nor loopback.
	 * @throws Session_Store_Unavailable When the store refuses the row.
	 */
	public static function register_client( string $name, array $redirect_uris ): string {
		$name = Sessions::clean_label( $name );
		if ( '' === $name ) {
			throw new \InvalidArgumentException( 'a client needs a name' );
		}
		if ( [] === $redirect_uris || \count( $redirect_uris ) > self::MAX_REDIRECT_URIS ) {
			throw new \InvalidArgumentException( 'a client registers one to five redirect URIs' );
		}
		$uris = [];
		foreach ( $redirect_uris as $uri ) {
			if ( ! \is_string( $uri ) || ! self::is_redirect_uri( $uri ) ) {
				throw new \InvalidArgumentException( 'a redirect URI is https, or http on localhost or 127.0.0.1' );
			}
			$uris[] = $uri;
		}
		$id = self::new_id();
		self::add(
			"oauth:client:{$id}",
			[
				'name'          => $name,
				'redirect_uris' => $uris,
				'created'       => self::now(),
			],
			self::CLIENT_TTL_S
		);
		return $id;
	}

	/**
	 * Whether a redirect URI is one a public client may register: https to
	 * any host, or plain http to a loopback host, with no userinfo to
	 * disguise the host and no fragment, whitespace or control character.
	 *
	 * @param string $uri The URI as registered.
	 */
	private static function is_redirect_uri( string $uri ): bool {
		if ( 1 === \preg_match( '/[\s#[:cntrl:]]/', $uri ) ) {
			return false;
		}
		$parts = \wp_parse_url( $uri );
		if ( ! \is_array( $parts ) || isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			return false;
		}
		$scheme = \strtolower( Core::str( $parts['scheme'] ?? null ) );
		$host   = \strtolower( Core::str( $parts['host'] ?? null ) );
		return '' !== $host && ( 'https' === $scheme || ( 'http' === $scheme && \in_array( $host, self::LOOPBACK_HOSTS, true ) ) );
	}

	/**
	 * A registered client, or null for an id no registration made or one
	 * that has lapsed.
	 *
	 * @param string $id Client id.
	 * @return array{name:string,redirect_uris:list<string>,created:int}|null
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	public static function client( string $id ): ?array {
		$row = self::row_by_id( 'client', $id )['row'] ?? null;
		if ( null === $row ) {
			return null;
		}
		return [
			'name'          => Core::str( $row['name'] ?? null ),
			'redirect_uris' => \array_values( \array_filter( Core::arr( $row['redirect_uris'] ?? null ), 'is_string' ) ),
			'created'       => Core::int( $row['created'] ?? null ),
		];
	}

	/**
	 * Issue a single-use authorization code bound to an approval.
	 *
	 * @param array{client:string,redirect_uri:string,challenge:string,resource:string,user:int,scope:string,name:string} $grant What the code is bound to.
	 * @return string The code, disclosed here alone.
	 * @throws Session_Store_Unavailable When the store refuses the row.
	 */
	public static function issue_code( array $grant ): string {
		$code = \bin2hex( \random_bytes( 32 ) );
		self::add( 'oauth:code:' . self::digest( $code ), $grant, self::CODE_TTL_S );
		return $code;
	}

	/**
	 * Take a code: its bound fields, once. The delete is the claim, so of
	 * two requests racing one code only the one that deleted it is answered.
	 *
	 * @param string $code The code a client presented.
	 * @return array<array-key,mixed>|null The bound fields; null for an
	 *                                     unknown, used or expired code.
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	public static function take_code( string $code ): ?array {
		$key   = 'oauth:code:' . self::digest( $code );
		$found = self::rows( [ $key ] )[ $key ] ?? null;
		return null !== $found && self::forget( $key ) ? $found['row'] : null;
	}

	/**
	 * Open a grant for thirty days and issue its first refresh token, then
	 * list it. A failure before the listing leaves only rows no one can name.
	 *
	 * @param array{client:string,user:int,scope:string,resource:string,name:string} $grant The approval.
	 * @return array{grant:string,refresh:string} The grant id and its refresh token.
	 * @throws Session_Store_Unavailable When the store refuses a row or the listing.
	 */
	public static function open_grant( array $grant ): array {
		$id = self::new_id();
		self::add( "oauth:grant:{$id}", $grant + [ 'created' => self::now() ], self::GRANT_TTL_S );
		$refresh = self::issue_refresh( $id, self::GRANT_TTL_S );
		self::index( self::GRANTS, $id, self::GRANT_TTL_S );
		return [
			'grant'   => $id,
			'refresh' => $refresh,
		];
	}

	/** A fresh id: 128 random bits as 32 lowercase hex digits. */
	private static function new_id(): string {
		return \bin2hex( \random_bytes( 16 ) );
	}

	/**
	 * A live grant, its expiry read from its row's own.
	 *
	 * @param string $id Grant id.
	 * @return array{client:string,user:int,scope:string,resource:string,name:string,created:int,expires:int}|null
	 *         Null for a grant revoked, expired or never opened.
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	public static function grant( string $id ): ?array {
		$found = self::row_by_id( 'grant', $id );
		return null === $found ? null : self::grant_of( $found );
	}

	/**
	 * Run a refresh. A token whose rotation already claimed it answers that
	 * rotation's answer again, while its grant is live. A live token is
	 * rotated: the next token is stored, `$answer` mints the session and
	 * builds the token response, and the grace row claims the rotation before
	 * the live row is deleted, so a crash between the two never strands the
	 * grant. A request that loses the claim to another revokes the session it
	 * minted, drops the token it issued and answers the winner's answer. A
	 * spent token whose grace row has lapsed answers null within GRACE_S of
	 * its spend; one spent more than GRACE_S earlier revokes its grant.
	 *
	 * @param string   $refresh The refresh token a client presented.
	 * @param \Closure $answer  `function ( array $grant, string $grant_id, string $next_refresh ): array{answer: array, handle: string}`:
	 *                          the `grant()` record, its id and the next token
	 *                          in; the token response and the handle of the
	 *                          session it minted out.
	 * @return array<array-key,mixed>|null The token response; null for a token
	 *                                     unknown, refused or reused.
	 * @throws Session_Store_Unavailable When the store does not answer or refuses a row.
	 */
	public static function rotate( string $refresh, \Closure $answer ): ?array {
		$hash  = self::digest( $refresh );
		$live  = "oauth:refresh:{$hash}";
		$spent = "oauth:spent:{$hash}";
		$grace = "oauth:grace:{$hash}";
		$rows  = self::rows( [ $live, $spent, $grace ] );
		if ( isset( $rows[ $grace ] ) ) {
			return self::replay( $rows[ $grace ]['row'] );
		}
		if ( isset( $rows[ $live ] ) ) {
			return self::spend( $hash, Core::str( $rows[ $live ]['row']['grant'] ?? null ), $answer );
		}
		if ( ! isset( $rows[ $spent ] ) ) {
			return null;
		}
		if ( self::now() - Core::int( $rows[ $spent ]['row']['at'] ?? null ) > self::GRACE_S ) {
			self::revoke_grant( Core::str( $rows[ $spent ]['row']['grant'] ?? null ) );
		}
		return null;
	}

	/**
	 * End a grant and every session it minted. The grant goes first, so no
	 * refresh rotates while its sessions are revoked.
	 *
	 * @param string $grant Grant id; one no grant could have is ignored.
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	public static function revoke_grant( string $grant ): void {
		if ( ! Command_Auth::is_handle( $grant ) ) {
			return;
		}
		self::forget( "oauth:grant:{$grant}" );
		foreach ( \array_keys( Command_Auth::session_members( "oauth:grant-sessions:{$grant}" ) ) as $handle ) {
			if ( null === Command_Auth::revoke_session( (string) $handle ) ) {
				throw new Session_Store_Unavailable( 'the session store did not answer; a session the grant minted may still be live' );
			}
		}
	}

	/**
	 * Rotate a live refresh token: issue the next, have `$answer` mint the
	 * session, claim the rotation with the grace row, then delete the live
	 * row and record the spend. Until the claim lands nothing names the next
	 * token, so any exit before it, a throw included, deletes its row.
	 *
	 * @param string   $hash   The token's digest.
	 * @param string   $grant  The grant its row names.
	 * @param \Closure $answer As `rotate()` takes it.
	 * @return array<array-key,mixed>|null The token response; null when the grant is gone.
	 * @throws Session_Store_Unavailable When the store does not answer or refuses a row.
	 */
	private static function spend( string $hash, string $grant, \Closure $answer ): ?array {
		$found = self::row_by_id( 'grant', $grant );
		if ( null === $found ) {
			return null;
		}
		$next    = self::issue_refresh( $grant, $found['ttl'] );
		$table   = Command_Auth::session_table();
		$minted  = [];
		$claim   = [];
		$claimed = false;
		try {
			$minted  = Core::arr( $answer( self::grant_of( $found ), $grant, $next ) );
			$claim   = [
				'grant'  => $grant,
				'answer' => Core::arr( $minted['answer'] ?? null ),
			];
			$claimed = $table->add( "oauth:grace:{$hash}", $claim, self::GRACE_S );
		} finally {
			if ( ! $claimed ) {
				self::forget( 'oauth:refresh:' . self::digest( $next ) );
			}
		}
		if ( ! $claimed ) {
			return self::yield_claim( $hash, Core::str( $minted['handle'] ?? null ), $table->last_failure() );
		}
		self::forget( "oauth:refresh:{$hash}" );
		self::add(
			"oauth:spent:{$hash}",
			[
				'grant' => $grant,
				'at'    => self::now(),
			],
			$found['ttl']
		);
		return $claim['answer'];
	}

	/**
	 * Give way to the rotation that claimed a token first, once `spend()` has
	 * dropped the token this one issued: revoke the session this one minted
	 * and answer the winner's.
	 *
	 * @param string $hash    The token's digest.
	 * @param string $handle  The session this rotation minted.
	 * @param string $failure Why the claim was refused, for a store that held none.
	 * @return array<array-key,mixed>|null The winner's token response, or null.
	 * @throws Session_Store_Unavailable When no claim was held, so the store
	 *                                   refused it, or the store does not answer.
	 */
	private static function yield_claim( string $hash, string $handle, string $failure ): ?array {
		$grace  = "oauth:grace:{$hash}";
		$winner = self::rows( [ $grace ] )[ $grace ]['row'] ?? null;
		if ( null === Command_Auth::revoke_session( $handle ) ) {
			throw new Session_Store_Unavailable( 'the session store did not answer; a session a refresh minted may still be live' );
		}
		if ( null === $winner ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new Session_Store_Unavailable( "could not store an OAuth row: {$failure}" );
		}
		return self::replay( $winner );
	}

	/**
	 * The answer a grace row claimed, while its grant is live.
	 *
	 * @param array<array-key,mixed>|null $claim The grace row, `{ grant, answer }`.
	 * @return array<array-key,mixed>|null The token response, or null.
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	private static function replay( ?array $claim ): ?array {
		if ( null === $claim || null === self::row_by_id( 'grant', Core::str( $claim['grant'] ?? null ) ) ) {
			return null;
		}
		return Core::arr( $claim['answer'] ?? null );
	}

	/**
	 * Delete a row.
	 *
	 * @param string $key Row key.
	 * @return bool True when this call deleted a live row, false when none was there.
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	private static function forget( string $key ): bool {
		$table = Command_Auth::session_table();
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
		return $table->forget( $key ) ?? throw new Session_Store_Unavailable( "could not delete an OAuth row: {$table->last_failure()}" );
	}

	/**
	 * A grant's row as `grant()` answers it.
	 *
	 * @param array{row:array<array-key,mixed>,ttl:int} $found The row and the life it has left.
	 * @return array{client:string,user:int,scope:string,resource:string,name:string,created:int,expires:int}
	 */
	private static function grant_of( array $found ): array {
		$row = $found['row'];
		return [
			'client'   => Core::str( $row['client'] ?? null ),
			'user'     => Core::int( $row['user'] ?? null ),
			'scope'    => Core::str( $row['scope'] ?? null ),
			'resource' => Core::str( $row['resource'] ?? null ),
			'name'     => Core::str( $row['name'] ?? null ),
			'created'  => Core::int( $row['created'] ?? null ),
			'expires'  => self::now() + $found['ttl'],
		];
	}

	/**
	 * Issue a refresh token for a grant.
	 *
	 * @param string $grant Grant id.
	 * @param int    $life  What the grant has left, in seconds.
	 * @return string The token, disclosed here alone.
	 * @throws Session_Store_Unavailable When the store refuses the row.
	 */
	private static function issue_refresh( string $grant, int $life ): string {
		$refresh = \bin2hex( \random_bytes( 32 ) );
		self::add( 'oauth:refresh:' . self::digest( $refresh ), [ 'grant' => $grant ], $life );
		return $refresh;
	}

	/** The form a secret is stored under. */
	private static function digest( string $secret ): string {
		return \hash( 'sha256', $secret );
	}

	/**
	 * Store a row where no live one holds its key.
	 *
	 * @param string                 $key Row key.
	 * @param array<array-key,mixed> $row Row.
	 * @param int                    $ttl Its lifetime in seconds.
	 * @throws Session_Store_Unavailable When the store refuses it.
	 */
	private static function add( string $key, array $row, int $ttl ): void {
		$table = Command_Auth::session_table();
		if ( ! $table->add( $key, $row, $ttl ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new Session_Store_Unavailable( "could not store an OAuth row: {$table->last_failure()}" );
		}
	}

	/**
	 * Record a session a grant minted, for as long as the grant has left, so
	 * revoking the grant revokes it.
	 *
	 * @param string $grant  Grant id.
	 * @param string $handle Session handle.
	 * @return bool False when no live grant has the id, and nothing was recorded.
	 * @throws Session_Store_Unavailable When the store does not answer or refuses the member.
	 */
	public static function bind_session( string $grant, string $handle ): bool {
		$life = self::row_by_id( 'grant', $grant )['ttl'] ?? null;
		if ( null === $life ) {
			return false;
		}
		self::index( "oauth:grant-sessions:{$grant}", $handle, $life );
		return true;
	}

	/**
	 * Add one member to a set.
	 *
	 * @param string $set    Set key.
	 * @param string $member Member.
	 * @param int    $ttl    Its lifetime in seconds.
	 * @throws Session_Store_Unavailable When the store refuses it.
	 */
	private static function index( string $set, string $member, int $ttl ): void {
		$table = Command_Auth::session_table();
		if ( [] === $table->add_members( [ $set => [ [ $member => 1 ], $ttl ] ] ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new Session_Store_Unavailable( "could not index an OAuth row: {$table->last_failure()}" );
		}
	}

	/**
	 * A row keyed `oauth:<kind>:<id>`, or null; an id no mint could make
	 * never reaches the store.
	 *
	 * @param string $kind `client` or `grant`.
	 * @param string $id   The id.
	 * @return array{row:array<array-key,mixed>,ttl:int}|null
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	private static function row_by_id( string $kind, string $id ): ?array {
		$key = "oauth:{$kind}:{$id}";
		return Command_Auth::is_handle( $id ) ? self::rows( [ $key ] )[ $key ] ?? null : null;
	}

	/**
	 * The live grants, newest first: the `oauth:grants` set, then every row
	 * it names in one read.
	 *
	 * @return list<array{grant:string,name:string,client:string,scope:string,created:int,expires:int}>
	 * @throws Session_Store_Unavailable When the store does not answer, or the
	 *                                   set holds more than one read answers.
	 */
	public static function grants(): array {
		$ids = \array_map( 'strval', \array_keys( Command_Auth::session_members( self::GRANTS ) ) );
		if ( [] === $ids ) {
			return [];
		}
		$rows = self::rows( \array_map( static fn ( string $id ): string => "oauth:grant:{$id}", $ids ) );
		$now  = self::now();
		$list = [];
		foreach ( $ids as $id ) {
			$found = $rows[ "oauth:grant:{$id}" ] ?? null;
			if ( null === $found ) {
				continue;
			}
			$list[] = [
				'grant'   => $id,
				'name'    => Core::str( $found['row']['name'] ?? null ),
				'client'  => Core::str( $found['row']['client'] ?? null ),
				'scope'   => Core::str( $found['row']['scope'] ?? null ),
				'created' => Core::int( $found['row']['created'] ?? null ),
				'expires' => $now + $found['ttl'],
			];
		}
		\usort( $list, static fn ( array $a, array $b ): int => $b['created'] <=> $a['created'] );
		return $list;
	}

	/** The current second, on the substrate's clock. */
	private static function now(): int {
		return (int) Core::right_now();
	}

	/**
	 * The live rows among `$keys`, in one read, each with the life it has left.
	 *
	 * @param list<string> $keys Row keys.
	 * @return array<array-key,array{row:array<array-key,mixed>,ttl:int}>
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	private static function rows( array $keys ): array {
		$rows = [];
		foreach ( Command_Auth::session_entries( $keys ) as $key => $entry ) {
			if ( \is_array( $entry['value'] ) && isset( $entry['ttl'] ) ) {
				$rows[ $key ] = [
					'row' => $entry['value'],
					'ttl' => $entry['ttl'],
				];
			}
		}
		return $rows;
	}

}
