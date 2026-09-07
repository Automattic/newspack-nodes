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
	 * The verifier's own copy of the key lives in the selected cache.
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
	 * cache — verification recomputes an HMAC, so it cannot be hashed — and a
	 * day is already generous for something sitting readable in memcached.
	 */
	public const SESSION_TTL_MAX_S = 86400;

	/** Shortest session worth minting; below this a client re-auths mid-task. */
	public const SESSION_TTL_MIN_S = 60;

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
	 * @param string $scope One of Capabilities::READ|TUNE|MANAGE.
	 * @param int    $ttl   Lifetime in seconds, taken as given; a caller reading
	 *                      it off the wire clamps through bounded_ttl() first.
	 * @return array{handle:string,key:string,scope:string,expires_in:int,now:int}
	 * @throws \InvalidArgumentException On a scope outside the ladder.
	 * @throws \RuntimeException When the session could not be persisted.
	 */
	public static function mint_session( string $scope = Capabilities::MANAGE, int $ttl = self::SESSION_TTL_S ): array {
		if ( ! Capabilities::scope_covers( $scope, Capabilities::READ ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers.
			throw new \InvalidArgumentException( "unknown session scope: {$scope}" );
		}
		$handle = \bin2hex( \random_bytes( 16 ) );
		$key    = \bin2hex( \random_bytes( 32 ) );
		if ( ! self::store_session( $handle, $key, $ttl, $scope, self::current_user() ) ) {
			throw new \RuntimeException( 'Command_Auth: could not persist the session (no cache backend, or handle taken)' );
		}
		return [
			'handle'     => $handle,
			'key'        => $key,
			'scope'      => $scope,
			'expires_in' => $ttl,
			// The minter signs TIMESTAMP; the client aligns to this clock.
			'now'        => \time(),
		];
	}

	/** The minting user, or 0 outside a WP runtime. */
	private static function current_user(): int {
		return \function_exists( 'get_current_user_id' ) ? \get_current_user_id() : 0;
	}

	/**
	 * Store a session key under its handle. `add()`, never `set()`: a handle can
	 * never displace a live session, so a colliding mint fails rather than
	 * fixating someone else's. False when the handle is taken or no cache backend
	 * exists (fail closed).
	 *
	 * `shared_first()` prefers configured memcached, preserving shared scope.
	 * Without it, the WordPress web pool can mint and verify through its one APCu
	 * cache domain. The nonce claim orders the tiers the other way round, on
	 * purpose: a session minted in a web request must resolve in a worker, while
	 * a nonce only has to be unique to the process verifying it.
	 *
	 * @param string $handle Session handle the verifier resolves the key from.
	 * @param string $key    Signing key.
	 * @param int    $ttl    Lifetime in seconds; never slid on use.
	 * @param string $scope  Ceiling the verifier applies, READ|TUNE|MANAGE.
	 * @param int    $user   WordPress id of the minting user, 0 for nobody.
	 */
	public static function store_session( string $handle, string $key, int $ttl, string $scope = Capabilities::MANAGE, int $user = 0 ): bool {
		$backend = Cache_Backend::shared_first();
		return null !== $backend && $backend->add(
			self::session_address( $handle ),
			[ 'k' => $key, 's' => $scope, 'u' => $user ],
			$ttl
		);
	}

	/**
	 * Drop a session so its key stops verifying immediately. The cache entry IS
	 * the authority; a directory row without it is already dead. False when the
	 * handle was already gone, or no cache backend exists.
	 */
	public static function revoke_session( string $handle ): bool {
		$backend = Cache_Backend::shared_first();
		return null !== $backend && $backend->delete( self::session_address( $handle ) );
	}

	/**
	 * Which of these handles still have a live key, as a `handle => true` set.
	 * ONE multi-get: `Sessions::MAX_ROWS` caps the directory at 50, so asking
	 * per row is 50 round trips for one screen.
	 *
	 * @param list<string> $handles Handles to test.
	 * @return array<string,true>
	 */
	public static function live_handles( array $handles ): array {
		$backend = Cache_Backend::shared_first();
		if ( null === $backend || [] === $handles ) {
			return [];
		}
		$addresses = [];
		foreach ( $handles as $handle ) {
			$addresses[ self::session_address( $handle ) ] = $handle;
		}
		$live = [];
		foreach ( $backend->read_multi( \array_keys( $addresses ) ) as $address => $record ) {
			if ( null !== $record && isset( $addresses[ $address ] ) ) {
				$live[ $addresses[ $address ] ] = true;
			}
		}
		return $live;
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

	/** Whether a session with this remote is already established in this process. */
	public static function has_session( string $destination ): bool {
		return isset( self::$sessions[ $destination ] );
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
	 * Authorize closure for a verifier process: a worker, the `/command` request
	 * scope, or the SSE stream.
	 *
	 * Accepts a command if it is either in-process (Message::LOCAL set) OR carries
	 * a valid HMAC. LOCAL cannot cross a process boundary — packed() slices the
	 * canonical seven fields and unpacked() rejects any line that is not exactly
	 * seven — so a command arriving over IPC or the wire never has it; trusting
	 * LOCAL therefore only admits the process's own commands (a worker loading its
	 * topology via Shell::eval_script), while every wire command still requires a
	 * signature.
	 *
	 * @return \Closure(Command_Interpreter_Node, array<int,mixed>): bool
	 */
	public static function verifier(): \Closure {
		return \Closure::fromCallable( [ self::class, 'authorize_command' ] );
	}

	/**
	 * The verifier policy: accept an in-process (LOCAL) command, else require a
	 * valid HMAC. Named (not an inline closure) so its int-keyed Message type is
	 * honored end-to-end.
	 *
	 * @param Command_Interpreter_Node $interpreter Node handling the command.
	 * @param array<int,mixed>         $message     Command to authorize.
	 */
	private static function authorize_command( Command_Interpreter_Node $interpreter, array $message ): bool {
		return isset( $message[ Message::LOCAL ] )
			|| self::verify( $message, null, $interpreter );
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
	 */
	public static function verify( array $message, ?int $now = null, ?Command_Interpreter_Node $interpreter = null ): bool {
		// @longform ONE exit for the ceiling. `check()` installs the verified
		// session's scope on the way through, and this closes it on EVERY
		// refusal — the mutation is global and only interpret() restores it,
		// so a caller outside that lifetime (a sibling plugin, a test) cannot
		// leave a wider ceiling standing than the command that failed.
		$ok = self::check( $message, $now, $interpreter );
		if ( ! $ok ) {
			Capabilities::$session_scope = Capabilities::NONE;
		}
		return $ok;
	}

	/**
	 * The verification itself. Installs the resolved scope as it goes; `verify()`
	 * owns what happens to it on refusal.
	 *
	 * @param array<int,mixed>              $message     Message to verify.
	 * @param int|null                      $now         Verification time; defaults to time().
	 * @param Command_Interpreter_Node|null $interpreter Node to log a refusal through.
	 */
	private static function check( array $message, ?int $now, ?Command_Interpreter_Node $interpreter ): bool {
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
			$record = self::load_session_record( Core::as_string( $handle ) );
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

	/**
	 * Resolve a session record by handle: `{key, scope, user}`, or null on any
	 * miss.
	 *
	 * A record stored as a bare key string is scopeless and nobody's: it reads
	 * back as MANAGE under user 0 rather than being discarded, because
	 * discarding logs out every client still holding one.
	 *
	 * @param string $handle Session handle, as stamped into the envelope.
	 * @return array{key:string,scope:string,user:int}|null
	 */
	public static function load_session_record( string $handle ): ?array {
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return null;
		}
		$record = $backend->get( self::session_address( $handle ) );
		if ( \is_string( $record ) ) {
			return '' === $record ? null : [ 'key' => $record, 'scope' => Capabilities::MANAGE, 'user' => 0 ];
		}
		if ( ! \is_array( $record ) ) {
			return null;
		}
		// An absent field reads null — a non-scalar, so as_string() gives ''.
		$key   = Core::as_string( $record['k'] ?? null, '' );
		$scope = Core::as_string( $record['s'] ?? null, '' );
		if ( '' === $scope ) {
			$scope = Capabilities::MANAGE;
		}
		return '' === $key
			? null
			: [ 'key' => $key, 'scope' => $scope, 'user' => Core::num_int( $record['u'] ?? 0 ) ];
	}

	/**
	 * Cache address for a session key. Namespaced per site TWICE over, and the
	 * inner half is the one that matters: the cache is shared infrastructure,
	 * not a trusted store, so a handle minted by another install — or planted
	 * directly by anything that can write memcached — must not resolve here.
	 * Deriving that from the site SECRET costs nothing; anyone who can compute
	 * it already holds the salt and can sign outright. `site_key()` adds no
	 * secrecy on top, only membership in the shared rotation, so bumping
	 * KEY_VERSION invalidates live sessions along with everything else.
	 */
	private static function session_address( string $handle ): string {
		return Cache_Backend::site_key(
			'cmd-session:' . \substr( \hash_hmac( 'sha256', 'session-ns', \wp_salt( 'nonce' ) ), 0, 16 ) . ':' . $handle
		);
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
