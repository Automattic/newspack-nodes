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
 * Static signer and verifier — no instance state, so a Shell, a worker or a
 * REST handler reaches it without wiring a node.
 *
 * @phpstan-type Session_Record array{key:string,scope:string,user:int,ttl:int,label:string,created:int}
 */
class Command_Auth {

	/** Max accepted future skew (verifier clock behind the signer). */
	public const MAX_FUTURE_S = 10;

	/** Max accepted age of a signature; with MAX_FUTURE_S, the acceptance span. */
	public const MAX_PAST_S = 20;

	/**
	 * Single-use nonce TTL. Must comfortably outlive the FULL acceptance span
	 * (MAX_PAST_S + MAX_FUTURE_S = 30s of verifier-wall time): the nonce entry is
	 * claimed at first-verify time, not at ts, so a clock-skewed verifier whose
	 * entry expires while the freshness window is still open would otherwise let a
	 * replay through at the boundary. 60s doubles that span.
	 */
	public const NONCE_TTL_S = 60;

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
	 * The session Table's namespace, one row per session keyed by its handle,
	 * on the wpdb backend, because every web host mints and every host
	 * verifies, which a host-local SQLite file cannot serve (ADR-24). `wp
	 * nodes tables` lists it by this name and flushes it only when named.
	 */
	public const SESSIONS_TABLE = 'nodes-sessions';

	/** The session Table's backend, which `wp nodes tables` lists beside it. */
	public const SESSIONS_BACKEND = 'wpdb';

	/** Every handle a mint makes: 32 lowercase hex digits. */
	public const HANDLE_PATTERN = '/^[0-9a-f]{32}$/D';

	/** The session Table, built on first use and shared by every caller. */
	private static ?Table_Node $table = null;

	/**
	 * The sessions the current batch has read, by handle; `batch_verifier()`
	 * empties it as each batch begins.
	 *
	 * @var array<string,Session_Record|null>
	 */
	private static array $batch = [];

	/**
	 * Expired session rows one mint deletes. No worker's tick purges a Table
	 * built in code, so each mint reclaims what has expired; sessions expire
	 * one per mint at most, so any batch above one keeps pace, and 64 clears
	 * a backlog left while nothing minted.
	 */
	private const SESSION_PURGE_ROWS = 64;

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
	 * The row is claimed with `add()`, never `set()`: a handle can never
	 * displace a live session, so a colliding mint fails rather than fixating
	 * someone else's. It carries the key, the scope the verifier applies, the
	 * minting user, the label and when it was minted, and expires with the
	 * session, the one record of when it lapses; the same mint reclaims up to
	 * SESSION_PURGE_ROWS rows already expired.
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
		if ( ! Capabilities::scope_covers( $scope, Capabilities::READ ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \InvalidArgumentException( "unknown session scope: {$scope}" );
		}
		$handle = \bin2hex( \random_bytes( 16 ) );
		$key    = \bin2hex( \random_bytes( 32 ) );
		$now    = (int) Core::right_now();
		$table  = self::session_table();
		$row    = [
			'k' => $key,
			's' => $scope,
			'u' => Core::current_user_id(),
			'l' => $label,
			'c' => $now,
		];
		if ( ! $table->add( $handle, $row, $ttl ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new Session_Store_Unavailable( "could not store the session: {$table->last_failure()}" );
		}
		$table->purge( self::SESSION_PURGE_ROWS );
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
	 * Drop a session so its key stops verifying immediately. The row IS the
	 * session; an index member naming it lists nothing once it is gone.
	 *
	 * @param string $handle Session handle.
	 * @return bool|null True when a live row went, false when none was there,
	 *                   null when the store did not answer, so the key may
	 *                   still verify.
	 * @throws Session_Store_Unavailable When the store will not open.
	 */
	public static function revoke_session( string $handle ): ?bool {
		return self::session_table()->forget( $handle );
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

	/**
	 * Authorize closure for ONE batch of commands, the `/command` POST: each
	 * session is read once until the next batch begins, so k commands under
	 * one handle cost one read. Build one per batch, never one per process,
	 * or a revoke would not bite until the process ends.
	 *
	 * @return \Closure(Command_Interpreter_Node, array<int,mixed>): bool
	 */
	public static function batch_verifier(): \Closure {
		self::$batch = [];
		return \Closure::fromCallable( [ self::class, 'authorize_batch' ] );
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
		return isset( $message[ Message::LOCAL ] )
			|| self::verify( $message, null, $interpreter );
	}

	/**
	 * `authorize_command()`, resolving each session through the batch's own
	 * reads.
	 *
	 * @param Command_Interpreter_Node $interpreter Node handling the command.
	 * @param array<int,mixed>         $message     Command to authorize.
	 */
	private static function authorize_batch( Command_Interpreter_Node $interpreter, array $message ): bool {
		return isset( $message[ Message::LOCAL ] )
			|| self::verify( $message, null, $interpreter, self::batch_record( ... ) );
	}

	/**
	 * The session a handle names, read once a batch.
	 *
	 * @param string $handle Session handle.
	 * @return Session_Record|null
	 */
	private static function batch_record( string $handle ): ?array {
		if ( ! \array_key_exists( $handle, self::$batch ) ) {
			self::$batch[ $handle ] = self::load_session_record( $handle );
		}
		return self::$batch[ $handle ];
	}

	/**
	 * Verify a command Message's `auth` envelope: freshness window, HMAC, then a
	 * single-use nonce claim. Returns false on any failure (fail closed).
	 *
	 * A refusal reason logs through $interpreter — the node that HANDLED the
	 * command, passed in by its authorize call. Never look one up:
	 * `drop_message()` throttles on the node-midfixed text, so a refusal logged
	 * through any other node misnames the drop and suppresses on a key of its
	 * own. Two refusals log nothing: an unknown or expired handle, and a
	 * replayed nonce.
	 *
	 * @param array<int,mixed>              $message     Message to verify.
	 * @param int|null                      $now         Verification time; defaults to time().
	 * @param Command_Interpreter_Node|null $interpreter Node to log a refusal through.
	 * @param (\Closure(string): (Session_Record|null))|null $load
	 *        The session a handle names; null reads it from the store.
	 */
	public static function verify( array $message, ?int $now = null, ?Command_Interpreter_Node $interpreter = null, ?\Closure $load = null ): bool {
		// @longform ONE exit for the ceiling. `check()` installs the verified
		// session's scope on the way through, and this closes it on EVERY
		// refusal — the mutation is global and only interpret() restores it,
		// so a caller outside that lifetime (a sibling plugin, a test) cannot
		// leave a wider ceiling standing than the command that failed.
		$ok = self::check( $message, $now, $interpreter, $load ?? self::load_session_record( ... ) );
		if ( ! $ok ) {
			Capabilities::$session_scope = Capabilities::NONE;
		}
		return $ok;
	}

	/**
	 * Resolve a live session by handle: `{key, scope, user, ttl, label,
	 * created}`, where `ttl` is the whole seconds its row has left. Null on
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
	 *
	 * @param list<string> $handles Session handles.
	 * @return array<string,Session_Record>
	 * @throws Session_Store_Unavailable When the store will not open or does
	 *                                   not answer, naming why.
	 */
	public static function load_session_records( array $handles ): array {
		$handles = \array_values( \array_filter( $handles, static fn ( string $handle ): bool => 1 === \preg_match( self::HANDLE_PATTERN, $handle ) ) );
		if ( [] === $handles ) {
			return [];
		}
		$table = self::session_table();
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
		$entries = $table->lookup_entries( $handles ) ?? throw new Session_Store_Unavailable( "could not read the sessions: {$table->last_failure()}" );
		$records = [];
		foreach ( $entries as $handle => $entry ) {
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
			}
		}
		return $records;
	}

	/**
	 * The session Table: SESSIONS_TABLE on SESSIONS_BACKEND, built in code as
	 * any Table outside a graph is, once a process. Every entry states its own
	 * lifetime, so the Table's own is the default a mint asks for.
	 *
	 * @api `wp nodes tables` lists and flushes it.
	 * @return Table_Node The Table.
	 * @throws Session_Store_Unavailable When it will not open, naming why.
	 */
	public static function session_table(): Table_Node {
		try {
			return self::$table ??= Table_Node::table( self::SESSIONS_TABLE, self::SESSION_TTL_S, self::SESSIONS_BACKEND );
		} catch ( \RuntimeException | \LogicException $e ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new Session_Store_Unavailable( 'the session store is unavailable: ' . $e->getMessage(), 0, $e );
		}
	}

	/**
	 * The verification itself. Installs the resolved scope as it goes; `verify()`
	 * owns what happens to it on refusal.
	 *
	 * @param array<int,mixed>              $message     Message to verify.
	 * @param int|null                      $now         Verification time; defaults to time().
	 * @param Command_Interpreter_Node|null $interpreter Node to log a refusal through.
	 * @param \Closure(string): (Session_Record|null) $load The session a handle names.
	 */
	private static function check( array $message, ?int $now, ?Command_Interpreter_Node $interpreter, \Closure $load ): bool {
		$type  = $message[ Message::TYPE ]      ?? null;
		$ts    = $message[ Message::TIMESTAMP ] ?? null;
		$value = $message[ Message::VALUE ]     ?? null;
		if ( ! self::is_request_command( $type, $ts, $value ) ) {
			$interpreter?->drop_message( $message, 'verification failed: wrong type' );
			return false;
		}
		$ts   = (int) $ts; // Second granularity: sign/verify truncate alike.
		$auth = $value['auth'] ?? null;
		if ( ! \is_array( $auth )
				|| ! isset( $auth['nonce'], $auth['sig'] ) ) {
			$interpreter?->drop_message( $message, 'verification failed: bad envelope' );
			return false;
		}
		$nonce_in = $auth['nonce'];
		$nonce    = Core::as_string( $nonce_in );
		$now      = $now ?? \time();

		// Freshness: not stale, not implausibly in the future.
		if ( $now - $ts > self::MAX_PAST_S || $ts - $now > self::MAX_FUTURE_S ) {
			$interpreter?->drop_message( $message, 'verification failed: timestamp out of range' );
			return false;
		}

		// A handle names a session; no handle means the per-site secret.
		$handle = $auth['handle'] ?? null;
		if ( null === $handle ) {
			$key = self::secret();
			// The per-site secret is the site's own authority: no ceiling.
			Capabilities::$session_scope = null;
		} else {
			$record = $load( Core::as_string( $handle ) );
			if ( null === $record ) {
				return false;
			}
			$key = $record['key'];
			Capabilities::$session_scope = $record['scope'];
		}

		$canon = self::canonical( $ts, $value, $nonce );
		if ( null === $canon ) {
			$interpreter?->drop_message( $message, 'verification failed: invalid signature' );
			return false;
		}
		$expected = \hash_hmac( 'sha256', $canon, $key );
		$sig      = $auth['sig'];
		if ( ! \hash_equals( $expected, Core::as_string( $sig ) ) ) {
			$interpreter?->drop_message( $message, 'verification failed: signature mismatch' );
			return false;
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
