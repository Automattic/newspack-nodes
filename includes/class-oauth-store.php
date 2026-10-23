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
 */
final class Oauth_Store {

	/**
	 * The one list of scopes OAuth, and through it MCP, may grant: read and
	 * tune. Restoring `manage` is one edit to this list.
	 */
	public const SCOPES = [ Capabilities::READ, Capabilities::TUNE ];

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
	public const LOOPBACK_HOSTS = [ 'localhost', '127.0.0.1' ];

	/** The set whose members are every grant's id. */
	private const GRANTS = 'oauth:grants';

	/** `register_client()`'s refusal code for a name that cleans to nothing. */
	public const REFUSED_NAME = 1;

	/** `register_client()`'s refusal code for its redirect URIs. */
	public const REFUSED_REDIRECT_URIS = 2;

	/**
	 * Register a public client. Its name is kept as a session label is,
	 * through `Sessions::clean_label()`, because registration is open to anyone.
	 *
	 * @param string       $name          The client's self-declared name.
	 * @param array<mixed> $redirect_uris One to five URIs, each `https://` or
	 *                                    `http://` on localhost or 127.0.0.1,
	 *                                    with no userinfo, fragment or space,
	 *                                    and none `wp_redirect()` would alter.
	 * @return array{id:string,name:string,redirect_uris:list<string>,created:int}
	 *         The client as kept.
	 * @throws \InvalidArgumentException With code REFUSED_NAME on an empty
	 *                                   name, REFUSED_REDIRECT_URIS on a count
	 *                                   outside one to five or a URI neither
	 *                                   https nor loopback.
	 * @throws Session_Store_Unavailable When the store refuses the row.
	 */
	public static function register_client( string $name, array $redirect_uris ): array {
		$name = Sessions::clean_label( $name );
		if ( '' === $name ) {
			throw new \InvalidArgumentException( 'a client needs a name', self::REFUSED_NAME );
		}
		if ( [] === $redirect_uris || \count( $redirect_uris ) > self::MAX_REDIRECT_URIS ) {
			throw new \InvalidArgumentException( 'a client registers one to five redirect URIs', self::REFUSED_REDIRECT_URIS );
		}
		$uris = [];
		foreach ( $redirect_uris as $uri ) {
			if ( ! \is_string( $uri ) || ! self::is_redirect_uri( $uri ) ) {
				throw new \InvalidArgumentException( 'a redirect URI is https, or http on localhost or 127.0.0.1', self::REFUSED_REDIRECT_URIS );
			}
			$uris[] = $uri;
		}
		$id     = self::new_id();
		$client = [
			'name'          => $name,
			'redirect_uris' => $uris,
			'created'       => self::now(),
		];
		self::add( "oauth:client:{$id}", $client, self::CLIENT_TTL_S );
		return [ 'id' => $id ] + $client;
	}

	/**
	 * Whether a redirect URI is one a public client may register: https to
	 * any host, or plain http to a loopback host, with no userinfo to
	 * disguise the host and no fragment, whitespace or control character,
	 * and sent as registered: `wp_redirect()` runs `wp_sanitize_redirect()`,
	 * which drops or encodes some bytes, so a URI it would alter is refused.
	 *
	 * @param string $uri The URI as registered.
	 */
	private static function is_redirect_uri( string $uri ): bool {
		if ( 1 === \preg_match( '/[\s#[:cntrl:]]/', $uri ) || \wp_sanitize_redirect( $uri ) !== $uri ) {
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
	 * Issue a single-use authorization code bound to an approval. The
	 * connection name labels every session the grant mints, so it is kept
	 * as a session label is, through `Sessions::clean_label()`.
	 *
	 * @param array{client:string,redirect_uri:string,challenge:string,resource:string,user:int,scope:string,name:string} $grant What the code is bound to.
	 * @return string The code, disclosed here alone.
	 * @throws Session_Store_Unavailable When the store refuses the row.
	 */
	public static function issue_code( array $grant ): string {
		$code          = \bin2hex( \random_bytes( 32 ) );
		$grant['name'] = Sessions::clean_label( $grant['name'] );
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
	 * its spend; one spent more than GRACE_S earlier revokes its grant. A
	 * token is rotated or replayed only for the client its grant was issued
	 * to, and for the grant's resource when the request names one; any other
	 * request answers null and spends nothing.
	 *
	 * @param string      $refresh  The refresh token a client presented.
	 * @param string      $client   The client presenting it.
	 * @param string|null $resource The resource the request names, if any.
	 * @param \Closure    $answer   `function ( array $grant, string $grant_id, string $next_refresh ): array{answer: array, handle: string}`:
	 *                          the `grant()` record, its id and the next token
	 *                          in; the token response and the handle of the
	 *                          session it minted out.
	 * @return array<array-key,mixed>|null The token response; null for a token
	 *                                     unknown, refused or reused.
	 * @throws Session_Store_Unavailable When the store does not answer or refuses a row.
	 * @throws \RuntimeException What `$answer` throws, once the token it was
	 *                           handed is dropped.
	 */
	public static function rotate( string $refresh, string $client, ?string $resource, \Closure $answer ): ?array {
		$hash  = self::digest( $refresh );
		$live  = "oauth:refresh:{$hash}";
		$spent = "oauth:spent:{$hash}";
		$grace = "oauth:grace:{$hash}";
		$rows  = self::rows( [ $live, $spent, $grace ] );
		if ( isset( $rows[ $grace ] ) ) {
			return self::replay( $rows[ $grace ]['row'], $client, $resource );
		}
		if ( isset( $rows[ $live ] ) ) {
			$grant = Core::str( $rows[ $live ]['row']['grant'] ?? null );
			$found = self::issued_grant( $grant, $client, $resource );
			return null === $found ? null : self::spend( $hash, $grant, $found, $client, $resource, $answer );
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
	 * @param string                                    $hash   The token's digest.
	 * @param string                                    $grant  The grant its row names.
	 * @param array{row:array<array-key,mixed>,ttl:int} $found    The grant's row and the life it has left.
	 * @param string                                    $client   The client presenting the token.
	 * @param string|null                               $resource The resource the request names, if any.
	 * @param \Closure                                  $answer   As `rotate()` takes it.
	 * @return array<array-key,mixed>|null The token response; null when the
	 *                                     claim's winner names a grant now gone.
	 * @throws Session_Store_Unavailable When the store does not answer or refuses a row.
	 */
	private static function spend( string $hash, string $grant, array $found, string $client, ?string $resource, \Closure $answer ): ?array {
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
			return self::yield_claim( $hash, Core::str( $minted['handle'] ?? null ), $table->last_failure(), $client, $resource );
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
	 * @param string      $hash     The token's digest.
	 * @param string      $handle   The session this rotation minted.
	 * @param string      $failure  Why the claim was refused, for a store that held none.
	 * @param string      $client   The client presenting the token.
	 * @param string|null $resource The resource the request names, if any.
	 * @return array<array-key,mixed>|null The winner's token response, or null.
	 * @throws Session_Store_Unavailable When no claim was held, so the store
	 *                                   refused it, or the store does not answer.
	 */
	private static function yield_claim( string $hash, string $handle, string $failure, string $client, ?string $resource ): ?array {
		$grace  = "oauth:grace:{$hash}";
		$winner = self::rows( [ $grace ] )[ $grace ]['row'] ?? null;
		if ( null === Command_Auth::revoke_session( $handle ) ) {
			throw new Session_Store_Unavailable( 'the session store did not answer; a session a refresh minted may still be live' );
		}
		if ( null === $winner ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new Session_Store_Unavailable( "could not store an OAuth row: {$failure}" );
		}
		return self::replay( $winner, $client, $resource );
	}

	/**
	 * The answer a grace row claimed, while its grant is live and was issued
	 * to `$client`, for `$resource` when one is named.
	 *
	 * @param array<array-key,mixed> $claim    The grace row, `{ grant, answer }`.
	 * @param string                 $client   The client asking.
	 * @param string|null            $resource The resource asked for, if any.
	 * @return array<array-key,mixed>|null The token response, or null.
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	private static function replay( array $claim, string $client, ?string $resource ): ?array {
		return null === self::issued_grant( Core::str( $claim['grant'] ?? null ), $client, $resource ) ? null : Core::arr( $claim['answer'] ?? null );
	}

	/**
	 * A live grant issued to `$client`, and for `$resource` when one is named.
	 *
	 * @param string      $grant    Grant id.
	 * @param string      $client   The client asking.
	 * @param string|null $resource The resource asked for, if any.
	 * @return array{row:array<array-key,mixed>,ttl:int}|null Null for any other.
	 * @throws Session_Store_Unavailable When the store does not answer.
	 */
	private static function issued_grant( string $grant, string $client, ?string $resource ): ?array {
		$found = self::row_by_id( 'grant', $grant );
		if ( null === $found || Core::str( $found['row']['client'] ?? null ) !== $client ) {
			return null;
		}
		return null === $resource || Core::str( $found['row']['resource'] ?? null ) === $resource ? $found : null;
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
	 * it names in one read, then their clients' rows in one more. A grant
	 * names its client by the name the client registered, or by none once
	 * that registration has lapsed.
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
		$rows    = self::rows( \array_map( static fn ( string $id ): string => "oauth:grant:{$id}", $ids ) );
		$clients = self::rows( \array_values( \array_unique( \array_map( static fn ( array $found ): string => 'oauth:client:' . Core::str( $found['row']['client'] ?? null ), $rows ) ) ) );
		$now     = self::now();
		$list    = [];
		foreach ( $ids as $id ) {
			$found = $rows[ "oauth:grant:{$id}" ] ?? null;
			if ( null === $found ) {
				continue;
			}
			$client = 'oauth:client:' . Core::str( $found['row']['client'] ?? null );
			$list[] = [
				'grant'   => $id,
				'name'    => Core::str( $found['row']['name'] ?? null ),
				'client'  => Core::str( $clients[ $client ]['row']['name'] ?? null ),
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
