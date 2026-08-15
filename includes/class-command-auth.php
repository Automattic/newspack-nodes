<?php
/**
 * Command_Auth: HMAC sign/verify for command provenance (server tier).
 *
 * The browser's trusted origin IS its process (see Message::LOCAL); the server
 * legitimately receives commands over the wire, so it can't strip — it must tell
 * an authorized wire-command from an injected one with an unforgeable marker.
 * The node that MINTS a command signs its semantics — the attached `wp nodes
 * cli` Shell via `sign()`, a browser or peer under its session key via
 * `sign_for()`. Ingress does NOT sign: conferring authority on arrival would
 * make `HTTP_In` an oracle (ADR-15). Verifier processes (workers, /command
 * request scope) install `verifier()` as CommandInterpreter's authorize policy
 * and refuse anything that doesn't verify.
 *
 * Signs the SEMANTICS, never the routing: name + arguments + ts + nonce.
 * TO/FROM mutate as Router peels and nodes stamp FROM, so they are not
 * signed. The envelope rides inside VALUE (`auth`) because it must survive IPC
 * to reach the worker — it cannot ride in the stripped Message::LOCAL field.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Command_Auth {

	/** Max accepted future skew (verifier clock behind the signer). */
	public const MAX_FUTURE_S = 10;

	/** Max accepted age of a signature (two 10s windows of straddle tolerance). */
	public const MAX_PAST_S = 20;

	/**
	 * Single-use nonce TTL. Must comfortably outlive the FULL acceptance span
	 * (MAX_PAST_S + MAX_FUTURE_S = 30s of verifier-wall time): the nonce entry is
	 * claimed at first-verify time, not at ts, so a clock-skewed verifier whose
	 * entry expires while the freshness window is still open would otherwise let a
	 * replay through at the boundary. 60s = span + a generous margin.
	 */
	public const NONCE_TTL_S = 60;

	/**
	 * Single-use claim seam. `function ( string $nonce, int $ttl ): bool` — true
	 * when the nonce is newly claimed (first use), false on replay OR when no
	 * store is available (fail closed). Lazily-defaulted at the call site to an
	 * atomic `Cache_Backend::local_first()->add()`. Tests reassign to exercise
	 * the window/HMAC logic without a real cache, and to drive the replay path.
	 *
	 * @var \Closure(string, int): bool|null
	 */
	public static ?\Closure $claim_nonce = null;

	/**
	 * Client-side sessions keyed by VAULT ID, per-process. Not by url: two
	 * entries may share a host with different credentials, and a url can be
	 * edited while the id stays — both would alias one session across two
	 * authorization contexts. Lost on worker restart,
	 * which costs one re-auth. The verifier's own copy lives in the selected cache.
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
	 * Stamp an `auth` envelope onto a command Message's VALUE. No-op unless TYPE
	 * is a request command — TM_COMMAND without TM_RESPONSE/TM_ERROR (TM_NOREPLY
	 * rides along fine).
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
	 * @param array<int,mixed> $message Message (mutated in place).
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
	 * $handle names the session the verifier must resolve $key from; null means
	 * the per-site secret. It is deliberately outside `canonical()`: repointing
	 * an envelope at another handle only makes the signature stop matching.
	 *
	 * TYPE is outside it too, so a caller may still OR flags in afterwards —
	 * which is what lets the mint sign at build time.
	 *
	 * @param array<int,mixed> $message Message (mutated in place).
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
	 * Takes no destination or user: the verifier resolves a key by handle and
	 * nothing more, and a signature under one session's key is verifiable only
	 * by the site that minted it. The SCOPE does ride along, because it is the
	 * ceiling the verifier applies — the holder of the key cannot restate it.
	 *
	 * @param string $scope One of Capabilities::READ|TUNE|MANAGE.
	 * @param int    $ttl   Lifetime in seconds; defaults to SESSION_TTL_S.
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
		if ( ! self::store_session( $handle, $key, $ttl, $scope ) ) {
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

	/**
	 * Store a session key under its handle. `add()`, never `set()`: a handle can
	 * never displace a live session, so a colliding mint fails rather than
	 * fixating someone else's. False when the handle is taken or no cache backend
	 * exists (fail closed).
	 *
	 * `shared_first()` prefers configured memcached, preserving shared scope.
	 * Without it, the WordPress web pool can mint and verify through its one APCu
	 * cache domain. This deliberately differs from the nonce claim's
	 * `local_first()` ordering.
	 */
	public static function store_session( string $handle, string $key, int $ttl, string $scope = Capabilities::MANAGE ): bool {
		$backend = Cache_Backend::shared_first();
		return null !== $backend && $backend->add(
			self::session_address( $handle ),
			[ 'k' => $key, 's' => $scope ],
			$ttl
		);
	}

	/**
	 * Drop a session so its key stops verifying immediately. The cache entry IS
	 * the authority; a directory row without it is already dead.
	 */
	public static function revoke_session( string $handle ): bool {
		$backend = Cache_Backend::shared_first();
		return null !== $backend && $backend->delete( self::session_address( $handle ) );
	}

	/**
	 * Which of these handles still have a live key, as a `handle => true` set.
	 * ONE multi-get: a directory listing asking per row is 50 round trips for
	 * one screen, and the rest of the substrate batches its cache reads.
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
	 * Drop the session with a remote, so the next command to it re-auths. Fired
	 * when a Vault entry is re-credentialed or removed: the far side has
	 * forgotten the key, or the credentials that bought it no longer apply.
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
	 * Authorize closure for verifier processes (worker, /command request scope).
	 *
	 * Accepts a command if it is either in-process (Message::LOCAL set) OR carries
	 * a valid HMAC. LOCAL cannot cross a process boundary — packed() strips index 7
	 * and unpacked() rejects 8-field lines — so a command arriving over IPC/the wire
	 * never has it; trusting LOCAL therefore only admits the process's own commands
	 * (e.g. a worker loading its topology via Shell::eval_script), while every
	 * wire command still requires a signature.
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
	 * @param array<int,mixed>        $message
	 */
	private static function authorize_command( Command_Interpreter_Node $interpreter, array $message ): bool {
		return isset( $message[ Message::LOCAL ] )
			|| self::verify( $message, null, $interpreter );
	}

	/**
	 * Verify a command Message's `auth` envelope: freshness window, HMAC, then a
	 * single-use nonce claim. Returns false on any failure (fail closed).
	 *
	 * Refusal reasons are logged through $interpreter — the node that HANDLED the
	 * command, passed in by its authorize call. Never look one up: logging under
	 * a different interpreter than the one refusing also defeats its
	 * generic-"unauthorized" suppression, so each refusal logs twice.
	 *
	 * @param array<int,mixed>            $message     Message to verify.
	 * @param int|null                     $now         Verification time; defaults to time().
	 * @param Command_Interpreter_Node|null $interpreter Node to log a refusal through.
	 */
	public static function verify( array $message, ?int $now = null, ?Command_Interpreter_Node $interpreter = null ): bool {
		// @longform ONE exit for the ceiling. `check()` installs the verified
		// session's scope on the way through, and this closes it on EVERY
		// refusal — the mutation is global and only interpret() restores it, so
		// a caller outside that lifetime (a sibling plugin, a test) must not be
		// able to leave a wider ceiling standing than the command that failed.
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

		// Strict single-use: claim the nonce; false = replay or no store.
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
	 * browser signs the same string with its session key. Returns
	 * null when the value can't be JSON-encoded (e.g. non-UTF-8 arguments) so the
	 * caller fails closed instead of collapsing distinct commands onto HMAC('').
	 *
	 * @param array<array-key,mixed> $value Command struct (name/arguments).
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
	 * Resolve a session record by handle: `{key, scope}`, or null on any miss.
	 *
	 * A record written before scopes existed is a bare key string, and its
	 * authority was unrestricted — so it reads back as MANAGE rather than being
	 * discarded, which would log every live client out on deploy.
	 *
	 * @return array{key:string,scope:string}|null
	 */
	public static function load_session_record( string $handle ): ?array {
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return null;
		}
		$record = $backend->get( self::session_address( $handle ) );
		if ( \is_string( $record ) ) {
			return '' === $record ? null : [ 'key' => $record, 'scope' => Capabilities::MANAGE ];
		}
		if ( ! \is_array( $record ) ) {
			return null;
		}
		$key   = Core::as_string( $record['k'] ?? null, '' );
		// as_string() substitutes only for a NON-scalar, so `?? ''` yields ''.
		$scope = Core::as_string( $record['s'] ?? null, '' );
		if ( '' === $scope ) {
			$scope = Capabilities::MANAGE;
		}
		return '' === $key ? null : [ 'key' => $key, 'scope' => $scope ];
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
	 * VALUE. sign() and verify() share this ONE predicate so the signer and the
	 * verifier agree on what is signable at all. TYPE gates that decision but is
	 * not itself signed.
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
