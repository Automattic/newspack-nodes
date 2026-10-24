<?php
/**
 * Command_Auth: HMAC sign/verify for command provenance (server tier).
 *
 * The browser's trusted origin IS its process, which `Message::LOCAL` marks. A
 * server legitimately receives commands over the wire, which LOCAL cannot
 * cross, so it needs an unforgeable marker to tell an authorized command from
 * an injected one. The node that MINTS a command signs its semantics: the
 * attached `wp nodes cli` Shell through `sign()`, a hub addressing a spoke
 * through `sign_for()` under the session key it holds for that spoke. A
 * browser mints and signs the same envelope in `src/runtime/command-auth.js`.
 * Ingress does NOT sign: conferring authority on arrival would make `HTTP_In`
 * an oracle (ADR-15). Verifier processes — workers, the `/command` request
 * scope, the SSE-stream process — install `verifier()` as the interpreter's
 * authorize policy and refuse whatever does not verify.
 *
 * Signs the SEMANTICS, never the routing: ts + name + arguments + nonce.
 * Router peels TO and nodes stamp FROM in transit, so neither is signed. The
 * envelope rides inside VALUE (`auth`) because it must survive IPC to reach a
 * worker, and `packed()` strips LOCAL at that boundary.
 *
 * A session also carries a SCOPE. Verifying installs it as
 * `Capabilities::$session_scope`, the ceiling over the one command being
 * handled; a refusal leaves `Capabilities::NONE`, and
 * `Command_Interpreter_Node::interpret()` restores what stood before.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Static signer and verifier, so a Shell, a worker or a REST handler reaches
 * it without wiring a node. Its one instance is a `/command` batch, bound
 * into the closure `batch_verifier()` answers.
 *
 * @phpstan-type Session_Record array{key:string,scope:string,user:int,ttl:int,label:string,created:int,grant?:string,resource?:string}
 */
class Command_Auth {

	/** Max accepted future skew (verifier clock behind the signer). */
	public const MAX_FUTURE_S = 10;

	/** Max accepted age of a signature; with MAX_FUTURE_S, the acceptance span. */
	public const MAX_PAST_S = 20;

	/**
	 * Single-use nonce TTL. The nonce entry is claimed at first-verify time,
	 * not at ts, so it must outlive every span in which the same command can
	 * still verify, or a replay finds its claim expired. That is the FULL
	 * acceptance span (MAX_PAST_S + MAX_FUTURE_S = 30s of verifier-wall time)
	 * for a clock-skewed verifier, and BATCH_MAX_AGE_S (140s) for a command
	 * queued behind slow verbs in one `/command` batch, which a host's 120s
	 * gateway timeout bounds.
	 */
	public const NONCE_TTL_S = 150;

	/**
	 * Wall age at which a command in a batch is refused at its own turn,
	 * 140s: a claim taken at the earliest first verification, MAX_FUTURE_S
	 * before the signature, expires that very second, so no replay outlasts
	 * its claim, and it covers a batch a 120s gateway lets run to its end.
	 */
	private const BATCH_MAX_AGE_S = self::NONCE_TTL_S - self::MAX_FUTURE_S;

	/** The refusal of a command signed outside its freshness window. */
	private const STALE = 'verification failed: timestamp out of range';

	/**
	 * Single-use claim seam. `function ( string $nonce, int $ttl ): bool` — true
	 * when the nonce is newly claimed (first use), false on replay OR when no
	 * store is available (fail closed). Lazily-defaulted at the call site to an
	 * atomic `Cache_Backend::local_first()->add()`. Tests reassign to exercise
	 * the freshness and HMAC logic without a real cache, and drive the replay
	 * path.
	 *
	 * @var (\Closure(string, int): bool)|null
	 */
	public static ?\Closure $claim_nonce = null;

	/**
	 * Client-side sessions keyed by VAULT ID, per-process. Not by url: two
	 * entries may share a host with different credentials, and a url can be
	 * edited while the id stays — both would alias one session across two
	 * authorization contexts. Lost on worker restart, which costs one re-auth.
	 * The verifier's own copy of the key lives in the session store.
	 *
	 * @var array<string,array{handle:string,key:string}>
	 */
	private static array $sessions = [];

	/**
	 * Session-key lifetime. Fixed, never slid on use: a leaked handle expires on a
	 * bounded schedule no matter how busy it is. Clients re-auth on refusal.
	 */
	public const SESSION_TTL_S = 3600;

	/**
	 * Longest session a caller may ask for. The key stays RECOVERABLE in the
	 * store — verification recomputes an HMAC, so it cannot be hashed — and a
	 * day is already generous for something sitting readable in the database.
	 */
	public const SESSION_TTL_MAX_S = 86400;

	/** Shortest session worth minting; below this a client re-auths mid-task. */
	public const SESSION_TTL_MIN_S = 60;

	/**
	 * The session Table's name before `session_store()` scopes it to the
	 * install: one row per session keyed by its handle, on the backend
	 * `sessions_backend()` names (ADR-24).
	 */
	public const SESSIONS_TABLE = 'nodes-sessions';

	/** The backend whose store holds the sessions, so a switch flushes the one it leaves. */
	public const SESSIONS_IN_USE_OPTION = 'newspack_nodes_sessions_in_use';

	/**
	 * The backends `sessions_backend` may name: `sqlite`, a file on this host,
	 * or `wpdb`, which every web host shares. Both hold set members, which
	 * the labelled index needs.
	 */
	public const SESSIONS_BACKENDS = [ 'sqlite', 'wpdb' ];

	/** The optional row columns an OAuth session carries, each by its record field. */
	private const BINDINGS = [
		'g' => 'grant',
		'r' => 'resource',
	];

	/**
	 * The resource every substrate door is: none, so `admits_resource()`
	 * spends only a site-wide session there and refuses a grant session.
	 */
	public const SITE_WIDE = '';

	/** Random bytes in a session handle, written as twice as many hex digits. */
	private const HANDLE_BYTES = 16;

	/** Random bytes in a session key, written as twice as many hex digits. */
	private const KEY_BYTES = 32;

	/** Every handle a mint makes, as an unanchored regex fragment. */
	public const HANDLE_PATTERN = '[0-9a-f]{' . 2 * self::HANDLE_BYTES . '}';

	/** Every key a mint makes, as an unanchored regex fragment. */
	public const KEY_PATTERN = '[0-9a-f]{' . 2 * self::KEY_BYTES . '}';

	/** The session Table writes go through, built on first use. */
	private static ?Table_Node $table = null;

	/** The session Table reads go through, built on first use. */
	private static ?Table_Node $reader = null;

	/**
	 * The sessions one batch has read, by handle.
	 *
	 * @var array<string,Session_Record|null>
	 */
	private array $read = [];

	/**
	 * Expired session rows one mint deletes. No worker's tick purges a Table
	 * built in code, so each mint reclaims what has expired; sessions expire
	 * one per mint at most, so any batch above one keeps pace, and 64 clears
	 * a backlog left while nothing minted.
	 */
	private const SESSION_PURGE_ROWS = 64;

	/**
	 * One batch, the instance a `batch_verifier()` closure is bound to.
	 *
	 * @param int $arrival When the batch arrived; every command in it is judged fresh against it.
	 */
	private function __construct( private readonly int $arrival ) {
	}

	/**
	 * Stamp an `auth` envelope onto a command Message's VALUE, under the
	 * per-site secret and with no handle. That secret is the same-host answer:
	 * the attached cli's Shell signs with it over a filesystem-gated IPC
	 * partition, where the signer already sits inside the trust boundary.
	 *
	 * No-op unless TYPE is a request command — TM_COMMAND without
	 * TM_RESPONSE/TM_ERROR (TM_NOREPLY rides along fine).
	 *
	 * @param array<int,mixed> $message Message (mutated in place).
	 */
	public static function sign( array &$message ): void {
		self::stamp( $message, self::secret(), null );
	}

	/**
	 * Mint one command for the spoke an egress speaks for, signed under that
	 * spoke's session, for the caller to fill, as the browser's
	 * `Node.command()` hands one back. No session means nothing is minted and
	 * `$ask_session` runs, because every minter refuses to queue unsigned and
	 * nothing else would ask. The minter passes its own throttle there — a
	 * link asks on its own second of the heartbeat cadence, a fan-out on its
	 * send cadence — so a minter retrying every tick never handshakes every
	 * tick. Every per-destination signed mint goes through here, so a minter
	 * decides only what to send, where, and how often to ask.
	 *
	 * @param HTTP_Out_Node $egress      The egress whose spoke the command is for.
	 * @param string        $from        The minter's name, where the reply returns.
	 * @param string        $to          The path the command addresses.
	 * @param string        $verb        Command name the spoke's interpreter runs.
	 * @param list<string>  $arguments   Command argument tokens.
	 * @param \Closure      $ask_session Asks the egress for a session, at the minter's pace.
	 * @return array<int,mixed>|null The signed command, or null with no session.
	 */
	public static function mint_for( HTTP_Out_Node $egress, string $from, string $to, string $verb, array $arguments, \Closure $ask_session ): ?array {
		$spoke = $egress->vault_id();
		if ( ! self::has_session( $spoke ) ) {
			$ask_session();
			return null;
		}
		$message = HTTP_Out_Node::command_message( $from, $to, $verb, $arguments );
		self::sign_for( $spoke, $message );
		return $message;
	}

	/**
	 * Sign for a specific remote, under the session key established with it.
	 * Choosing the key IS the destination binding — a signature under one
	 * remote's key verifies only there — which is how a command is pinned to its
	 * destination without signing TO, a field Router peels in transit.
	 *
	 * No session means no signature. An unsigned command is refused downstream,
	 * which is the correct failure: minters must wait for the session rather
	 * than emit something that will rot before it can be believed.
	 *
	 * @param string           $destination Vault entry id of the remote.
	 * @param array<int,mixed> $message     Message (mutated in place).
	 */
	public static function sign_for( string $destination, array &$message ): void {
		$session = self::$sessions[ $destination ] ?? null;
		if ( null === $session ) {
			Core::print_less_often( 'Command_Auth: no session for ', $destination, '; refusing to sign' );
			return;
		}
		self::stamp( $message, $session['key'], $session['handle'] );
	}

	/**
	 * Stamp an `auth` envelope under $key. No-op unless TYPE is a request command
	 * — TM_COMMAND without TM_RESPONSE/TM_ERROR (TM_NOREPLY rides along fine).
	 *
	 * $handle rides in the envelope but stays outside `canonical()`, so it is
	 * not signed: repointing an envelope at another handle only makes the
	 * signature stop matching.
	 *
	 * TYPE is outside it too, so a caller may still OR flags in afterwards —
	 * which is what lets the mint sign at build time.
	 *
	 * @param array<int,mixed> $message Message (mutated in place).
	 * @param string           $key     HMAC key: the per-site secret, or a session key.
	 * @param string|null      $handle  Session the verifier resolves $key from; null
	 *                                  means the per-site secret.
	 */
	private static function stamp( array &$message, string $key, ?string $handle ): void {
		$type  = $message[ Message::TYPE ]      ?? null;
		$ts    = $message[ Message::TIMESTAMP ] ?? null;
		$value = $message[ Message::VALUE ]     ?? null;
		if ( ! self::is_request_command( $type, $ts, $value ) ) {
			return;
		}
		$ts    = (int) $ts; // Second granularity, matching freshness window.
		$nonce = \bin2hex( \random_bytes( 16 ) );
		$canon = self::canonical( $ts, $value, $nonce );
		if ( null === $canon ) {
			// Leave un-encodable args unsigned so the verifier refuses them.
			Core::print_less_often( 'Command_Auth: un-encodable command arguments; refusing to sign' );
			return;
		}
		$envelope = [
			'nonce' => $nonce,
			'sig'   => \hash_hmac( 'sha256', $canon, $key ),
		];
		if ( null !== $handle ) {
			$envelope['handle'] = $handle;
		}
		$value['auth']             = $envelope;
		$message[ Message::VALUE ] = $value;
	}

	/** Whether a session with this remote is already established in this process. */
	public static function has_session( string $destination ): bool {
		return isset( self::$sessions[ $destination ] );
	}

	/**
	 * Mint a session: a random key under a random handle. Both are generated
	 * here — a caller-supplied handle could collide with or fixate a live
	 * session, and caller-supplied entropy is unverifiable.
	 *
	 * Takes no destination: the verifier resolves a key by handle and nothing
	 * more, and a signature under one session's key is verifiable only by the
	 * site that minted it. The SCOPE does ride along, because it is the ceiling
	 * the verifier applies — the holder of the key cannot restate it. The
	 * minting user is read off the runtime rather than passed, so a caller
	 * cannot mint a session as somebody else.
	 *
	 * The reply discloses the key as `secret`, the name `Core::is_secret_property()`
	 * masks, so no redactor on either side of the wire prints it.
	 *
	 * @param string $scope One of Capabilities::READ|TUNE|MANAGE.
	 * @param int    $ttl   Lifetime in seconds, taken as given; a caller reading
	 *                      it off the wire clamps through bounded_ttl() first.
	 * @param string $label The operator's name for it, as `Sessions` lists it;
	 *                      empty for a session nothing lists.
	 *
	 * @return array{handle:string,secret:string,scope:string,expires_in:int,now:int}
	 * @throws \InvalidArgumentException On a scope outside the ladder.
	 * @throws Session_Store_Unavailable When the store will not open or refuses
	 *                                   the row, naming why.
	 */
	public static function mint_session( string $scope = Capabilities::MANAGE, int $ttl = self::SESSION_TTL_S, string $label = '' ): array {
		return self::write_session( $scope, $ttl, Core::current_user_id(), $label, [] );
	}

	/**
	 * Mint the session an OAuth grant issues, from the grant alone: for the
	 * user who approved it, not whoever is current, with the approved scope,
	 * labelled with the connection's name, bound to the grant and to the
	 * resource it was issued for, and recorded in the grant's session index,
	 * so revoking the grant revokes it. The `labelled` index never names it:
	 * the grant is what lists. It lives SESSION_TTL_S, or what the grant has
	 * left when that is less, so it outlives neither the grant nor the index.
	 * A grant missing its resource or user, or holding a scope outside
	 * `Oauth_Store::SCOPES`, mints nothing: a session naming no resource is admitted at every
	 * door. A session the grant cannot record is revoked before the refusal,
	 * so no live key escapes the grant. The grant is read again once the
	 * session is recorded: a revoke deletes the grant before it reads the
	 * index, so either it sees this session or this read sees the grant gone.
	 *
	 * @api The OAuth token endpoint mints through it.
	 * @param string $grant The grant's id.
	 * @return array{handle:string,secret:string,scope:string,expires_in:int,now:int}
	 * @throws \RuntimeException When no live grant has the id.
	 * @throws \UnexpectedValueException When the grant names no resource, no
	 *                                   user, or a scope outside
	 *                                   `Oauth_Store::SCOPES`.
	 * @throws Session_Store_Unavailable When the store will not open, does not
	 *                                   answer, refuses the row or the index,
	 *                                   or does not answer the revoke of a
	 *                                   session it could not record.
	 */
	public static function mint_grant_session( string $grant ): array {
		$gone     = "no live grant {$grant}; no session was minted for it";
		$approval = Oauth_Store::grant( $grant );
		$now      = (int) Core::right_now();
		if ( null === $approval || $approval['expires'] <= $now ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \RuntimeException( $gone );
		}
		$malformed = match ( true ) {
			'' === $approval['resource'] => 'names no resource',
			$approval['user'] < 1 => 'names no user',
			! \in_array( $approval['scope'], Oauth_Store::SCOPES, true ) => "names the scope {$approval['scope']}; a grant holds " . \implode( ' or ', Oauth_Store::SCOPES ),
			default => null,
		};
		if ( null !== $malformed ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \UnexpectedValueException( "grant {$grant} {$malformed}; no session was minted for it" );
		}
		$binding = [
			'grant'    => $grant,
			'resource' => $approval['resource'],
		];
		$session = self::write_session( $approval['scope'], \min( self::SESSION_TTL_S, $approval['expires'] - $now ), $approval['user'], $approval['name'], $binding );
		$bound   = false;
		try {
			$bound = Oauth_Store::bind_session( $grant, $session['handle'] ) && null !== Oauth_Store::grant( $grant );
		} finally {
			if ( ! $bound && null === self::revoke_session( $session['handle'] ) ) {
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
				throw new Session_Store_Unavailable( "the session store did not answer; the session minted for grant {$grant} may still be live" );
			}
		}
		if ( ! $bound ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \RuntimeException( $gone );
		}
		return $session;
	}

	/**
	 * Drop a session so its key stops verifying immediately. The row IS the
	 * session; an index member naming it lists nothing once it is gone. A
	 * handle no mint could make never reaches the store, so no other row in
	 * it, an OAuth row among them, can be deleted through here.
	 *
	 * @param string $handle Session handle.
	 * @return bool|null True when a live row went, false when none was there,
	 *                   null when the store did not answer, so the key may
	 *                   still verify.
	 * @throws Session_Store_Unavailable When the store will not open.
	 */
	public static function revoke_session( string $handle ): ?bool {
		return self::is_handle( $handle ) ? self::session_table()->forget( $handle ) : false;
	}

	/**
	 * Store one session row, the one writer every mint shares. The row is
	 * claimed with `add()`, never `set()`: a handle can never displace a live
	 * session, so a colliding mint fails rather than fixating someone else's.
	 * It carries the key, the scope the verifier applies, the user, the label
	 * and when it was minted, plus each BINDINGS column `$binding` fills, and
	 * expires with the session, the one record of when it lapses; the same
	 * mint reclaims up to SESSION_PURGE_ROWS rows already expired.
	 *
	 * @param string                $scope   One of Capabilities::READ|TUNE|MANAGE.
	 * @param int                   $ttl     Lifetime in seconds.
	 * @param int                   $user    Whose authority the session spends.
	 * @param string                $label   The operator's name for it, or empty.
	 * @param array<string,string>  $binding The `grant` and `resource` an OAuth
	 *                                       session names; empty otherwise.
	 * @return array{handle:string,secret:string,scope:string,expires_in:int,now:int}
	 * @throws \InvalidArgumentException On a scope outside the ladder.
	 * @throws Session_Store_Unavailable When the store will not open or refuses
	 *                                   the row, naming why.
	 */
	private static function write_session( string $scope, int $ttl, int $user, string $label, array $binding ): array {
		if ( ! Capabilities::scope_covers( $scope, Capabilities::READ ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \InvalidArgumentException( "unknown session scope: {$scope}" );
		}
		$handle = \bin2hex( \random_bytes( self::HANDLE_BYTES ) );
		$key    = \bin2hex( \random_bytes( self::KEY_BYTES ) );
		$now    = (int) Core::right_now();
		$table  = self::session_table();
		$row    = [
			'k' => $key,
			's' => $scope,
			'u' => $user,
			'l' => $label,
			'c' => $now,
		];
		foreach ( self::BINDINGS as $column => $field ) {
			if ( isset( $binding[ $field ] ) ) {
				$row[ $column ] = $binding[ $field ];
			}
		}
		if ( ! $table->add( $handle, $row, $ttl, self::SESSION_PURGE_ROWS ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new Session_Store_Unavailable( "could not store the session: {$table->last_failure()}" );
		}
		return [
			'handle'     => $handle,
			'secret'     => $key,
			'scope'      => $scope,
			'expires_in' => $ttl,
			// The minter signs TIMESTAMP; the client aligns to this clock.
			'now'        => $now,
		];
	}

	/**
	 * The session Table writes go through: `session_store()` on the
	 * configured backend, built in code once a process for MANY_WRITERS,
	 * because every web process mints into it and no tick reaches it. Every
	 * entry states its own lifetime, so the Table's own is the default a mint
	 * asks for.
	 *
	 * @api `Sessions::revoke_all()` flushes it.
	 * @return Table_Node The Table.
	 * @throws Session_Store_Unavailable When it will not open, or the config
	 *                                   names no backend it can, naming why.
	 */
	public static function session_table(): Table_Node {
		return self::$table ??= self::open_store( Table_Node::MANY_WRITERS );
	}

	/**
	 * A set's live members in the session Table, member => value, read up to
	 * `Table_Node::MAX_MEMBERS_LIMIT`; past that the read refuses, naming the
	 * `revoke --all` that clears it, rather than answering a part.
	 *
	 * @api `Sessions::listing()` and `Oauth_Store` read their indexes through it.
	 * @param string $set Set key.
	 * @return array<array-key,mixed> Empty for a set with no live member.
	 * @throws Session_Store_Unavailable When the store will not open or does
	 *                                   not answer, or the set holds more.
	 */
	public static function session_members( string $set ): array {
		$table = self::session_reader();
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
		$found = $table->members_of( [ $set ], Table_Node::MAX_MEMBERS_LIMIT ) ?? throw new Session_Store_Unavailable( "could not read the session index {$set}: {$table->last_failure()}" );
		if ( \array_key_exists( $set, $found ) && null === $found[ $set ] ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new Session_Store_Unavailable( 'more than ' . Table_Node::MAX_MEMBERS_LIMIT . " members are indexed under {$set}; `wp nodes session revoke --all` revokes every session" );
		}
		return $found[ $set ] ?? [];
	}

	/**
	 * Authorize closure for ONE batch of commands, the `/command` POST, bound
	 * to the batch it builds: that batch holds its arrival, the clock read
	 * here, and the sessions it has read, so k commands under one handle cost
	 * one read and a batch begun beside it touches neither. Every command's freshness is judged at
	 * that arrival: the commands dispatch one after another, so against the
	 * clock at each one's turn a slow verb would age the commands behind it
	 * past MAX_PAST_S. The wall clock at its turn still bounds a command: one
	 * reached BATCH_MAX_AGE_S (140 s) or more after it was signed is refused,
	 * because its nonce claim, taken at the first verification, lasts
	 * NONCE_TTL_S. Build one per batch, never one per process, or a revoke
	 * would not bite until the process ends and every signature would age
	 * against one stale clock.
	 *
	 * @return \Closure(Command_Interpreter_Node, array<int,mixed>): bool
	 */
	public static function batch_verifier(): \Closure {
		return ( new self( (int) Core::right_now() ) )->authorize_batch( ... );
	}

	/**
	 * Authorize closure for a process that verifies commands one at a time: a
	 * worker, or the SSE stream. Each session is read afresh, so a revoke
	 * bites the next command.
	 *
	 * @return \Closure(Command_Interpreter_Node, array<int,mixed>): bool
	 */
	public static function verifier(): \Closure {
		return \Closure::fromCallable( [ self::class, 'authorize_command' ] );
	}

	/** Clamp a requested lifetime into [SESSION_TTL_MIN_S, SESSION_TTL_MAX_S]. */
	public static function bounded_ttl( int $ttl ): int {
		return \max( self::SESSION_TTL_MIN_S, \min( self::SESSION_TTL_MAX_S, $ttl ) );
	}

	/**
	 * Drop the session with a remote, so the next command to it re-auths. Two
	 * callers reach it: a Vault entry re-credentialed or removed, whose
	 * credentials no longer buy the session, and a 401 from the far side, which
	 * has forgotten the key.
	 */
	public static function forget_session( string $destination ): void {
		unset( self::$sessions[ $destination ] );
	}

	/**
	 * Record the session established with a remote, for `sign_for()` to use.
	 * All three are required: an empty one means a malformed `/auth` response was
	 * read through a `??`, and the resulting signature would be refused at the far
	 * end under a misleading diagnosis. Fail here, where the cause is visible.
	 *
	 * @param string $destination Vault entry id of the remote.
	 * @param string $handle      Session handle the remote issued.
	 * @param string $key         Signing key from the same `/auth` response.
	 * @throws \InvalidArgumentException When any argument is empty.
	 */
	public static function remember_session( string $destination, string $handle, string $key ): void {
		if ( '' === $destination || '' === $handle || '' === $key ) {
			throw new \InvalidArgumentException( 'Command_Auth::remember_session() requires a destination, handle, and key' );
		}
		self::$sessions[ $destination ] = [
			'handle' => $handle,
			'key'    => $key,
		];
	}

	/**
	 * `authorize_command()` for this batch: each session through the batch's
	 * own reads, freshness judged at its arrival and bounded by the wall
	 * clock at the command's turn.
	 *
	 * @param Command_Interpreter_Node $interpreter Node handling the command.
	 * @param array<int,mixed>         $message     Command to authorize.
	 */
	private function authorize_batch( Command_Interpreter_Node $interpreter, array $message ): bool {
		return isset( $message[ Message::LOCAL ] )
			|| self::verify( $message, $this->arrival, (int) Core::right_now(), $interpreter, $this->batch_record( ... ) );
	}

	/**
	 * The session a handle names, read once a batch.
	 *
	 * @param string $handle Session handle.
	 * @return Session_Record|null
	 */
	private function batch_record( string $handle ): ?array {
		if ( ! \array_key_exists( $handle, $this->read ) ) {
			$this->read[ $handle ] = self::load_session_record( $handle );
		}
		return $this->read[ $handle ];
	}

	/**
	 * The verifier policy: accept an in-process (LOCAL) command, else require a
	 * valid HMAC. Named (not an inline closure) so its int-keyed Message type is
	 * honored end-to-end.
	 *
	 * LOCAL cannot cross a process boundary — packed() slices the canonical
	 * seven fields and unpacked() rejects any line that is not exactly seven —
	 * so a command arriving over IPC or the wire never has it; trusting LOCAL
	 * therefore only admits the process's own commands (a worker loading its
	 * topology via Shell::eval_script), while every wire command still
	 * requires a signature.
	 *
	 * @param Command_Interpreter_Node $interpreter Node handling the command.
	 * @param array<int,mixed>         $message     Command to authorize.
	 */
	private static function authorize_command( Command_Interpreter_Node $interpreter, array $message ): bool {
		if ( isset( $message[ Message::LOCAL ] ) ) {
			return true;
		}
		$now = (int) Core::right_now();
		return self::verify( $message, $now, $now, $interpreter );
	}

	/**
	 * Verify a command Message's `auth` envelope: freshness window, HMAC, then a
	 * single-use nonce claim. Returns false on any failure (fail closed).
	 *
	 * A refusal reason logs through $interpreter — the node that HANDLED the
	 * command, passed in by its authorize call. Never look one up:
	 * `drop_message()` throttles on the node-midfixed text, so a refusal logged
	 * through any other node misnames the drop and suppresses on a key of its
	 * own. The line reaches the error log alone (`refuse()`), so every refusal
	 * judged here answers its caller as an unknown handle does. Two refusals
	 * log nothing: an unknown or expired handle, and a replayed nonce. An
	 * unreadable session store and a missing nonce store are environment
	 * faults, reported to stderr like any other.
	 *
	 * @param array<int,mixed>              $message     Message to verify.
	 * @param int                           $now         When the command arrived, a batch's arrival.
	 * @param int                           $turn        The wall clock at the command's turn.
	 * @param Command_Interpreter_Node|null $interpreter Node to log a refusal through.
	 * @param (\Closure(string): (Session_Record|null))|null $load
	 *        The session a handle names; null reads it from the store.
	 */
	public static function verify( array $message, int $now, int $turn, ?Command_Interpreter_Node $interpreter = null, ?\Closure $load = null ): bool {
		// @longform ONE exit for the ceiling. `check()` installs the verified
		// session's scope on the way through, and this closes it on EVERY
		// refusal — the mutation is global and only interpret() restores it,
		// so a caller outside that lifetime (a sibling plugin, a test) cannot
		// leave a wider ceiling standing than the command that failed.
		$ok = self::check( $message, $now, $turn, $interpreter, $load ?? self::load_session_record( ... ) );
		if ( ! $ok ) {
			Capabilities::$session_scope = Capabilities::NONE;
			Capabilities::$session_label = null;
		}
		return $ok;
	}

	/**
	 * Resolve a live session by handle: `{key, scope, user, ttl, label,
	 * created}`, where `ttl` is the whole seconds its row has left, plus the
	 * `grant` and `resource` an OAuth session names. Null on
	 * a handle no mint could make, on a miss, on a row not shaped as
	 * `mint_session()` writes it, and on a store that will not answer, which
	 * is logged: a verifier fails closed rather than throw.
	 *
	 * @param string $handle Session handle, as stamped into the envelope.
	 * @return Session_Record|null
	 */
	public static function load_session_record( string $handle ): ?array {
		try {
			return self::load_session_records( [ $handle ] )[ $handle ] ?? null;
		} catch ( Session_Store_Unavailable $e ) {
			Core::print_less_often( 'Command_Auth: ', $e->getMessage() );
			return null;
		}
	}

	/**
	 * Every live session among these handles, in ONE read of the store, so a
	 * listing costs one statement a screen rather than one a row. Each is
	 * `load_session_record()`'s shape; a handle no mint could make never
	 * reaches the store, and one with no live row, or a row not shaped as a
	 * mint writes it — key, scope, label and when it was minted — is absent.
	 * A non-empty `g` or `r` reads back as `grant` or `resource`.
	 *
	 * @param list<string> $handles Session handles.
	 * @return array<string,Session_Record>
	 * @throws Session_Store_Unavailable When the store will not open or does
	 *                                   not answer, naming why.
	 */
	public static function load_session_records( array $handles ): array {
		$handles = \array_values( \array_filter( $handles, self::is_handle( ... ) ) );
		if ( [] === $handles ) {
			return [];
		}
		$records = [];
		foreach ( self::session_entries( $handles ) as $handle => $entry ) {
			$record = $entry['value'];
			if ( \is_array( $record ) && \is_string( $record['k'] ?? null ) && '' !== $record['k'] && \is_string( $record['s'] ?? null ) && \is_string( $record['l'] ?? null ) && \is_int( $record['c'] ?? null ) && isset( $entry['ttl'] ) ) {
				$records[ (string) $handle ] = [
					'key'     => $record['k'],
					'scope'   => $record['s'],
					'user'    => Core::num_int( $record['u'] ?? 0 ),
					'ttl'     => $entry['ttl'],
					'label'   => $record['l'],
					'created' => $record['c'],
				];
				foreach ( self::BINDINGS as $column => $field ) {
					if ( \is_string( $record[ $column ] ?? null ) && '' !== $record[ $column ] ) {
						$records[ (string) $handle ][ $field ] = $record[ $column ];
					}
				}
			}
		}
		return $records;
	}

	/**
	 * Each live row among `$keys` in the session Table, with the life it has
	 * left, in one read.
	 *
	 * @api `Oauth_Store` reads its rows through it.
	 * @param list<string> $keys Row keys.
	 * @return array<array-key,array{value: mixed, ttl?: int}>
	 * @throws Session_Store_Unavailable When the store will not open or does
	 *                                   not answer, naming why.
	 */
	public static function session_entries( array $keys ): array {
		$table = self::session_reader();
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
		return $table->lookup_entries( $keys ) ?? throw new Session_Store_Unavailable( "could not read the session store: {$table->last_failure()}" );
	}

	/**
	 * The session Table reads go through, built once a process: on SQLite a
	 * READER, so a verify opens the file read-only, runs no DDL and creates
	 * nothing, and reads nothing while no mint has made the file.
	 *
	 * @api `Sessions::listing()` reads through it.
	 * @return Table_Node The Table.
	 * @throws Session_Store_Unavailable As `session_table()`.
	 */
	public static function session_reader(): Table_Node {
		return self::$reader ??= self::open_store( Table_Node::READER );
	}

	/**
	 * Open the session Table with `$access`, once the store a switch of
	 * backend left behind is flushed.
	 *
	 * @param string $access A `Table_Node::table()` access.
	 * @return Table_Node The Table.
	 * @throws Session_Store_Unavailable When it will not open, naming why.
	 */
	private static function open_store( string $access ): Table_Node {
		try {
			$backend = self::sessions_backend();
			self::leave_store( $backend );
			return Table_Node::table( self::session_store(), self::SESSION_TTL_S, $backend, $access );
		} catch ( \RuntimeException | \LogicException $e ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new Session_Store_Unavailable( 'the session store is unavailable: ' . $e->getMessage(), 0, $e );
		}
	}

	/**
	 * Flush the store of the backend SESSIONS_IN_USE_OPTION records when it is
	 * not `$backend`, then record `$backend`, so a switch away and back
	 * revives no session. Whichever config layer made the switch, the first
	 * session read or write after it finds it.
	 *
	 * @param string $backend The configured backend.
	 * @throws \RuntimeException When the left store will not flush, or the
	 *                           record will not write.
	 */
	private static function leave_store( string $backend ): void {
		$left = \get_option( self::SESSIONS_IN_USE_OPTION, '' );
		if ( $backend === $left ) {
			return;
		}
		if ( \is_string( $left ) && \in_array( $left, self::SESSIONS_BACKENDS, true ) ) {
			Table_Node::table( self::session_store(), self::SESSION_TTL_S, $left, Table_Node::MANY_WRITERS )->flush();
		}
		if ( ! \update_option( self::SESSIONS_IN_USE_OPTION, $backend, true ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \RuntimeException( "could not record sessions on {$backend}" );
		}
	}

	/**
	 * The session Table's name, and on SQLite its file's stem: SESSIONS_TABLE
	 * scoped by `Cache_Backend::install_id()`, which no salt rotation moves,
	 * because installs whose base directories meet share one `tables/`.
	 *
	 * @api The retention sweep, uninstall and `wp nodes tables list` name it.
	 * @return string `nodes-sessions-<install>`.
	 * @throws \RuntimeException When the install cannot be identified.
	 */
	public static function session_store(): string {
		return self::SESSIONS_TABLE . '-' . Cache_Backend::install_id();
	}

	/**
	 * The session Table's backend, as the `sessions_backend` config key names
	 * it: one of SESSIONS_BACKENDS.
	 *
	 * @api `wp nodes tables list` reads it.
	 * @return string `sqlite` or `wpdb`.
	 * @throws \UnexpectedValueException On any other value.
	 */
	public static function sessions_backend(): string {
		$backend = Config::value( 'sessions_backend' );
		if ( ! \is_string( $backend ) || ! \in_array( $backend, self::SESSIONS_BACKENDS, true ) ) {
			throw new \UnexpectedValueException( \esc_html( 'sessions_backend must be one of ' . \implode( ', ', self::SESSIONS_BACKENDS ) . ', not ' . Core::as_string( $backend, \get_debug_type( $backend ) ) ) );
		}
		return $backend;
	}

	/**
	 * Whether `$id` has the shape a mint gives every handle, which the OAuth
	 * ids share, so a string no mint could make never reaches the store.
	 *
	 * @api `Oauth_Store` checks its client and grant ids through it.
	 * @param string $id The candidate.
	 */
	public static function is_handle( string $id ): bool {
		return 1 === \preg_match( '/^' . self::HANDLE_PATTERN . '$/D', $id );
	}

	/**
	 * The verification itself. Installs the resolved scope as it goes; `verify()`
	 * owns what happens to it on refusal.
	 *
	 * @param array<int,mixed>              $message     Message to verify.
	 * @param int                           $now         When the command arrived, a batch's arrival.
	 * @param int                           $turn        The wall clock at the command's turn.
	 * @param Command_Interpreter_Node|null $interpreter Node to log a refusal through.
	 * @param \Closure(string): (Session_Record|null) $load The session a handle names.
	 */
	private static function check( array $message, int $now, int $turn, ?Command_Interpreter_Node $interpreter, \Closure $load ): bool {
		$type  = $message[ Message::TYPE ]      ?? null;
		$ts    = $message[ Message::TIMESTAMP ] ?? null;
		$value = $message[ Message::VALUE ]     ?? null;
		if ( ! self::is_request_command( $type, $ts, $value ) ) {
			return self::refuse( $interpreter, $message, 'verification failed: wrong type', null );
		}
		$ts   = (int) $ts; // Second granularity: sign/verify truncate alike.
		$auth = $value['auth'] ?? null;
		if ( ! \is_array( $auth )
				|| ! isset( $auth['nonce'], $auth['sig'] ) ) {
			return self::refuse( $interpreter, $message, 'verification failed: bad envelope', null );
		}
		$nonce_in = $auth['nonce'];
		$nonce    = Core::as_string( $nonce_in );

		// A handle names a session; no handle means the per-site secret.
		$handle = $auth['handle'] ?? null;
		$record = null === $handle ? null : $load( Core::as_string( $handle ) );
		// A grant session counts as no session, here and in the refusal line.
		if ( null !== $record && ! self::admits_resource( $record, self::SITE_WIDE ) ) {
			$record = null;
		}
		$named = null === $record ? null : Core::as_string( $handle );

		// Stale at arrival, implausibly ahead, or outliving its nonce claim.
		if ( $now - $ts > self::MAX_PAST_S || $ts - $now > self::MAX_FUTURE_S || $turn - $ts >= self::BATCH_MAX_AGE_S ) {
			return self::refuse( $interpreter, $message, self::STALE, $named );
		}

		if ( null === $handle ) {
			$key = self::secret();
			// The per-site secret is the site's own authority: no ceiling.
			Capabilities::$session_scope = null;
			Capabilities::$session_label = null;
		} elseif ( null === $record ) {
			return false;
		} else {
			$key = $record['key'];
			Capabilities::$session_scope = $record['scope'];
			Capabilities::$session_label = $record['label'];
		}

		$canon = self::canonical( $ts, $value, $nonce );
		if ( null === $canon ) {
			return self::refuse( $interpreter, $message, 'verification failed: invalid signature', $named );
		}
		$expected = \hash_hmac( 'sha256', $canon, $key );
		$sig      = $auth['sig'];
		if ( ! \hash_equals( $expected, Core::as_string( $sig ) ) ) {
			return self::refuse( $interpreter, $message, 'verification failed: signature mismatch', $named );
		}

		// Strict single-use. A claim fails on replay, or with no store.
		$claim = self::$claim_nonce ?? static function ( string $nonce, int $ttl ): bool {
			$backend = Cache_Backend::local_first();
			if ( null === $backend ) {
				Core::print_less_often( 'Command_Auth: no APCu and no memcache; refusing command (single-use unverifiable)' );
				return false;
			}
			return $backend->add( Cache_Backend::site_key( 'cmd-nonce:' . $nonce ), 1, $ttl );
		};
		return $claim( $nonce, self::NONCE_TTL_S );
	}

	/**
	 * Canonical signing string: command semantics + ts + nonce. Never TYPE and
	 * never TO/FROM — the SEMANTICS are signed, not the envelope. Tachikoma's
	 * Command::sign covers `id:timestamp:name:arguments:payload` for the same
	 * reason, and excluding TYPE is what lets the mint sign at build time
	 * instead of after every flag has been OR'd in.
	 *
	 * The encoding is byte-for-byte what `JSON.stringify` produces, because the
	 * browser signs the same string with its session key in
	 * `src/runtime/command-auth.js`. `tests/fixtures/signatures.json` pins that
	 * parity from both languages: each port's own suite is internally consistent
	 * and stays green through a drift only the shared fixture catches.
	 *
	 * Returns null when the value can't be JSON-encoded (non-UTF-8 arguments,
	 * say) so the caller fails closed instead of collapsing distinct commands
	 * onto HMAC('').
	 *
	 * @param int                    $ts    Unix seconds, the signed TIMESTAMP.
	 * @param array<array-key,mixed> $value Command struct (name/arguments).
	 * @param string                 $nonce Single-use nonce, hex.
	 * @return string|null The string to HMAC, or null when it can't be encoded.
	 */
	private static function canonical( int $ts, array $value, string $nonce ): ?string {
		$name      = $value['name']      ?? '';
		$arguments = $value['arguments'] ?? [];
		// Flags match JSON.stringify (PHP would escape / and non-ASCII).
		$encoded   = \wp_json_encode(
			[
				$ts,
				Core::as_string( $name ),
				\is_array( $arguments ) ? \array_values( $arguments ) : [],
				$nonce,
			],
			\JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE
		);
		return false === $encoded ? null : $encoded;
	}

	/** Per-site HMAC secret, domain-separated from the spawn token. */
	private static function secret(): string {
		return \hash_hmac( 'sha256', 'nodes-command-v1', \wp_salt( 'nonce' ) );
	}

	/**
	 * Whether a session may be spent at `$resource`: one naming no resource
	 * is site-wide, and one naming a resource is spent there alone.
	 *
	 * @api Every door checks a session's audience through it: the MCP door
	 *      against its own resource, the substrate's doors against SITE_WIDE.
	 * @param Session_Record $record   The session, as `load_session_record()` answers it.
	 * @param string         $resource The resource the caller is.
	 */
	public static function admits_resource( array $record, string $resource ): bool {
		return ! isset( $record['resource'] ) || $resource === $record['resource'];
	}

	/**
	 * Log why a command was refused, through the interpreter that handled it,
	 * to the error log alone: a line in the response, the stream or the ring
	 * would tell a caller holding a handle without its key that it is live.
	 *
	 * The line names a live session's handle in its tail, so an operator can
	 * tell which client is misconfigured. The tail stays out of the throttle
	 * key, which is the reason alone: one line per reason a throttle window,
	 * which in the request scope is the whole POST, naming the first session
	 * refused for it, however many sessions a caller mints.
	 *
	 * @param Command_Interpreter_Node|null $interpreter Node to log through.
	 * @param array<int,mixed>              $message     The refused command.
	 * @param string                        $reason      Why it was refused.
	 * @param string|null                   $handle      The live session the command named, if any.
	 * @return false Always, the verdict check() answers.
	 */
	private static function refuse( ?Command_Interpreter_Node $interpreter, array $message, string $reason, ?string $handle ): bool {
		$tail = null === $handle ? '' : "handle: {$handle}";
		Core::error_log_only( static fn () => $interpreter?->drop_message( $message, $reason, $tail ) );
		return false;
	}

	/**
	 * True when a Message is a signable request command: TM_COMMAND without
	 * TM_RESPONSE/TM_ERROR, an integer TYPE, a numeric TIMESTAMP, and an array
	 * VALUE. Stamping and verification share this ONE predicate so the signer
	 * and the verifier agree on what is signable at all. TYPE gates that
	 * decision but is not itself signed.
	 *
	 * The decision reads the TYPE bits, never a `name` key in VALUE: a command
	 * whose VALUE carries no name still signs and verifies, and a non-command
	 * carrying one is left alone.
	 *
	 * @param mixed $type  Raw Message TYPE.
	 * @param mixed $ts    Raw Message TIMESTAMP.
	 * @param mixed $value Raw Message VALUE.
	 *
	 * @phpstan-assert-if-true int $type
	 * @phpstan-assert-if-true int|float|numeric-string $ts
	 * @phpstan-assert-if-true array<array-key,mixed> $value
	 */
	private static function is_request_command( $type, $ts, $value ): bool {
		return \is_integer( $type )
			&& ( $type & Message::TM_COMMAND )
			&& ! ( $type & ( Message::TM_RESPONSE | Message::TM_ERROR ) )
			&& \is_numeric( $ts )
			&& \is_array( $value );
	}
}
