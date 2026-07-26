<?php
/**
 * Command_Auth: HMAC sign/verify for command provenance (server tier).
 *
 * The browser's trusted origin IS its process (see Message::LOCAL); the server
 * legitimately receives commands over the wire, so it can't strip — it must tell
 * an authorized wire-command from an injected one with an unforgeable marker.
 * Issuers (HTTP_In after WP auth; attached `wp nodes cli`) `sign()` the command
 * semantics; verifier processes (workers, /command request scope) install
 * `verifier()` as CommandInterpreter's authorize policy and refuse anything that
 * doesn't verify.
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
	 * atomic `Core::$memd->add()`. Tests reassign to exercise the window/HMAC
	 * logic without a real memcache, and to drive the replay path.
	 *
	 * @var \Closure(string, int): bool|null
	 */
	public static ?\Closure $claim_nonce = null;

	/**
	 * Stamp an `auth` envelope onto a command Message's VALUE. No-op unless TYPE
	 * is a request command — TM_COMMAND without TM_RESPONSE/TM_ERROR (TM_NOREPLY
	 * rides along fine). The HMAC covers TYPE, so the signer's flags must match
	 * the verifier's.
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
	 * Client-side sessions keyed by VAULT ID, per-process. Not by url: two
	 * entries may share a host with different credentials, and a url can be
	 * edited while the id stays — both would alias one session across two
	 * authorization contexts. Lost on worker restart,
	 * which costs one re-auth. The verifier's own copy lives in the shared cache.
	 *
	 * @var array<string,array{handle:string,key:string}>
	 */
	private static array $sessions = [];

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
	 * Stamp an `auth` envelope under $key. No-op unless TYPE is a request command
	 * — TM_COMMAND without TM_RESPONSE/TM_ERROR (TM_NOREPLY rides along fine).
	 * The HMAC covers TYPE, so the signer's flags must match the verifier's.
	 *
	 * $handle names the session the verifier must resolve $key from; null means
	 * the per-site secret. It is deliberately outside `canonical()`: repointing
	 * an envelope at another handle only makes the signature stop matching.
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
		$canon = self::canonical( $type, $ts, $value, $nonce );
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
	 * True when a Message is a signable request command: TM_COMMAND without
	 * TM_RESPONSE/TM_ERROR, an integer TYPE, a numeric TIMESTAMP, and an array
	 * VALUE. sign() and verify() share this ONE predicate so the signer's flags
	 * can never drift from the verifier's — the HMAC covers TYPE, so a mismatch
	 * here would silently reject every command.
	 *
	 * @param mixed $type  Raw Message TYPE.
	 * @param mixed $ts    Raw Message TIMESTAMP.
	 * @param mixed $value Raw Message VALUE.
	 *
	 * @phpstan-assert-if-true int $type
	 * @phpstan-assert-if-true int|float|numeric-string $ts
	 * @phpstan-assert-if-true array<array-key, mixed> $value
	 */
	private static function is_request_command( $type, $ts, $value ): bool {
		return \is_integer( $type )
			&& ( $type & Message::TM_COMMAND )
			&& ! ( $type & ( Message::TM_RESPONSE | Message::TM_ERROR ) )
			&& \is_numeric( $ts )
			&& \is_array( $value );
	}

	/**
	 * Canonical signing string: message TYPE + command semantics + ts + nonce.
	 * Never TO/FROM (they mutate as Router peels and nodes stamp FROM).
	 *
	 * The encoding is byte-for-byte what `JSON.stringify` produces, because the
	 * browser signs the same string with its session key. Returns
	 * null when the value can't be JSON-encoded (e.g. non-UTF-8 arguments) so the
	 * caller fails closed instead of collapsing distinct commands onto HMAC('').
	 *
	 * @param array<array-key, mixed> $value Command struct (name/arguments).
	 */
	private static function canonical( int $type, int $ts, array $value, string $nonce ): ?string {
		$name      = $value['name']      ?? '';
		$arguments = $value['arguments'] ?? [];
		// Flags match JSON.stringify (PHP would escape / and non-ASCII).
		$encoded   = \wp_json_encode(
			[
				$type,
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
		return \hash_hmac( 'sha256', 'nodes-command-v1', \NONCE_SALT );
	}

	/**
	 * Session-key lifetime. Fixed, never slid on use: a leaked handle expires on a
	 * bounded schedule no matter how busy it is. Clients re-auth on refusal.
	 */
	public const SESSION_TTL_S = 3600;

	/**
	 * Cache address for a session key. Namespaced per site: the cache is shared
	 * infrastructure, not a trusted store, so a handle minted by another install
	 * — or planted directly by anything that can write memcached — must not
	 * resolve here. Deriving the namespace from the site secret costs nothing;
	 * anyone who can compute it already holds the salt and can sign outright.
	 */
	private static function session_address( string $handle ): string {
		return 'nodes-cmd-session:' . \substr( \hash_hmac( 'sha256', 'session-ns', \NONCE_SALT ), 0, 16 ) . ':' . $handle;
	}

	/**
	 * Mint a session: a random key under a random handle. Both are generated
	 * here — a caller-supplied handle could collide with or fixate a live
	 * session, and caller-supplied entropy is unverifiable.
	 *
	 * Takes no destination or user: the verifier resolves a key by handle and
	 * nothing more, and a signature under one session's key is verifiable only
	 * by the site that minted it. Scope lives with the client that holds the key.
	 *
	 * @return array{handle:string,key:string,expires_in:int,now:int}
	 * @throws \RuntimeException When the session could not be persisted.
	 */
	public static function mint_session(): array {
		$handle = \bin2hex( \random_bytes( 16 ) );
		$key    = \bin2hex( \random_bytes( 32 ) );
		if ( ! self::store_session( $handle, $key, self::SESSION_TTL_S ) ) {
			throw new \RuntimeException( 'Command_Auth: could not persist the session (no shared store, or handle taken)' );
		}
		return [
			'handle'     => $handle,
			'key'        => $key,
			'expires_in' => self::SESSION_TTL_S,
			// The minter signs TIMESTAMP; the client aligns to this clock.
			'now'        => \time(),
		];
	}

	/**
	 * Store a session key under its handle. `add()`, never `set()`: a handle can
	 * never displace a live session, so a colliding mint fails rather than
	 * fixating someone else's. False when the handle is taken or no shared store
	 * exists (fail closed).
	 *
	 * `shared_only()` — not the `local_first()` the nonce claim uses, and not
	 * `shared_first()` either: a session minted in a web request has to resolve
	 * in a worker, and the APCu arm both of those can fall back to is per-host
	 * and usually disabled under CLI. Storing there would succeed and then
	 * verify nowhere.
	 */
	public static function store_session( string $handle, string $key, int $ttl ): bool {
		$backend = Cache_Backend::shared_only();
		return null !== $backend && $backend->add( self::session_address( $handle ), $key, $ttl );
	}

	/** Resolve a session key by handle. Null on miss, on a non-string, or with no store. */
	public static function load_session( string $handle ): ?string {
		$backend = Cache_Backend::shared_only();
		if ( null === $backend ) {
			return null;
		}
		$key = $backend->get( self::session_address( $handle ) );
		return \is_string( $key ) && '' !== $key ? $key : null;
	}

	/**
	 * Verify a command Message's `auth` envelope: freshness window, HMAC, then a
	 * single-use nonce claim. Returns false on any failure (fail closed).
	 *
	 * @param array<int, mixed> $message Message to verify.
	 * @param int|null          $now     Verification time; defaults to time().
	 */
	public static function verify( array $message, ?int $now = null ): bool {
		$type        = $message[ Message::TYPE ]       ?? null;
		$ts          = $message[ Message::TIMESTAMP ]  ?? null;
		$value       = $message[ Message::VALUE ]      ?? null;
		$interpreter = Core::node( Node_Names::COMMAND_INTERPRETER );
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
		} else {
			$key = self::load_session( Core::as_string( $handle ) );
			if ( null === $key ) {
				$interpreter?->drop_message( $message, 'verification failed: unknown or expired session' );
				return false;
			}
		}

		$canon = self::canonical( $type, $ts, $value, $nonce );
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
			return $backend->add( 'nodes-cmd-nonce:' . $nonce, 1, $ttl );
		};
		return $claim( $nonce, self::NONCE_TTL_S );
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
	 * @return \Closure(array<int, mixed>): bool
	 */
	public static function verifier(): \Closure {
		return \Closure::fromCallable( [ self::class, 'authorize_command' ] );
	}

	/**
	 * The verifier policy: accept an in-process (LOCAL) command, else require a
	 * valid HMAC. Named (not an inline closure) so its int-keyed Message type is
	 * honored end-to-end.
	 *
	 * @param array<int, mixed> $message
	 */
	private static function authorize_command( array $message ): bool {
		return isset( $message[ Message::LOCAL ] ) || self::verify( $message );
	}
}
