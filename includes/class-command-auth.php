<?php
/**
 * Command_Auth: HMAC sign/verify for command provenance (server tier).
 *
 * The browser's trusted origin IS its process (see Message::LOCAL); the server
 * legitimately receives commands over the wire, so it can't strip — it must tell
 * an authorized wire-command from an injected one with an unforgeable marker.
 * Issuers (HTTP_In after WP auth; pivoted `wp nodes cli`) `sign()` the command
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

	/** Max accepted age of a signature (two 10s windows of straddle tolerance). */
	public const MAX_PAST_S = 20;

	/** Max accepted future skew (verifier clock behind the signer). */
	public const MAX_FUTURE_S = 10;

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
	 * @param int|null         $now     Signing time; defaults to time().
	 */
	public static function sign( array &$message, ?int $now = null ): void {
		$type  = $message[ Message::TYPE ]  ?? 0;
		$value = $message[ Message::VALUE ] ?? null;
		if ( ! \is_integer( $type )
				|| ! ( $type & Message::TM_COMMAND )
				|| ( $type & ( Message::TM_RESPONSE | Message::TM_ERROR ) )
				|| ! \is_array( $value ) ) {
			return;
		}
		$ts    = $now ?? \time();
		$nonce = \bin2hex( \random_bytes( 16 ) );
		$canon = self::canonical( $type, $value, $ts, $nonce );
		if ( null === $canon ) {
			// Un-encodable arguments: leave the command unsigned so the verifier
			// refuses it, rather than signing a collision-prone empty canonical.
			Core::print_less_often( 'Command_Auth: un-encodable command arguments; refusing to sign' );
			return;
		}
		$value['auth'] = [
			'ts'    => $ts,
			'nonce' => $nonce,
			'sig'   => \hash_hmac( 'sha256', $canon, self::secret() ),
		];
		$message[ Message::VALUE ] = $value;
	}

	/**
	 * Canonical signing string: message TYPE + command semantics + ts + nonce.
	 * Never TO/FROM (they mutate as Router peels and nodes stamp FROM). Returns
	 * null when the value can't be JSON-encoded (e.g. non-UTF-8 arguments) so the
	 * caller fails closed instead of collapsing distinct commands onto HMAC('').
	 *
	 * @param array<array-key, mixed> $value Command struct (name/arguments).
	 */
	private static function canonical( int $type, array $value, int $ts, string $nonce ): ?string {
		$name      = $value['name'] ?? '';
		$arguments = $value['arguments'] ?? '';
		$encoded   = \wp_json_encode(
			[
				$type,
				\is_scalar( $name ) ? (string) $name : '',
				\is_scalar( $arguments ) ? (string) $arguments : '',
				$ts,
				$nonce,
			]
		);
		return false === $encoded ? null : $encoded;
	}

	/** Per-site HMAC secret, domain-separated from the spawn token. */
	private static function secret(): string {
		return \hash_hmac( 'sha256', 'nodes-command-v1', \NONCE_SALT );
	}

	/**
	 * Verify a command Message's `auth` envelope: freshness window, HMAC, then a
	 * single-use nonce claim. Returns false on any failure (fail closed).
	 *
	 * @param array<int, mixed> $message Message to verify.
	 * @param int|null          $now     Verification time; defaults to time().
	 */
	public static function verify( array $message, ?int $now = null ): bool {
		$type        = $message[ Message::TYPE ]  ?? 0;
		$value       = $message[ Message::VALUE ] ?? null;
		$interpreter = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( ! \is_integer( $type )
				|| ! ( $type & Message::TM_COMMAND )
				|| ( $type & ( Message::TM_RESPONSE | Message::TM_ERROR ) )
				|| ! \is_array( $value ) ) {
			$interpreter?->drop_message( $message, 'verification failed: wrong type' );
			return false;
		}
		$auth = $value['auth'] ?? null;
		if ( ! \is_array( $auth )
				|| ! isset( $auth['ts'], $auth['nonce'], $auth['sig'] )
				|| ! \is_integer( $auth['ts'] ) ) {
			$interpreter?->drop_message( $message, 'verification failed: bad envelope' );
			return false;
		}
		$ts       = $auth['ts'];
		$nonce_in = $auth['nonce'];
		$nonce    = \is_scalar( $nonce_in ) ? (string) $nonce_in : '';
		$now      = $now ?? \time();

		// Freshness: not stale, not implausibly in the future.
		if ( $now - $ts > self::MAX_PAST_S || $ts - $now > self::MAX_FUTURE_S ) {
			$interpreter?->drop_message( $message, 'verification failed: timestamp out of range' );
			return false;
		}

		$canon = self::canonical( $type, $value, $ts, $nonce );
		if ( null === $canon ) {
			$interpreter?->drop_message( $message, 'verification failed: invalid signature' );
			return false;
		}
		$expected = \hash_hmac( 'sha256', $canon, self::secret() );
		$sig      = $auth['sig'];
		if ( ! \hash_equals( $expected, \is_scalar( $sig ) ? (string) $sig : '' ) ) {
			$interpreter?->drop_message( $message, 'verification failed: signature mismatch' );
			return false;
		}

		// Strict single-use: atomically claim the nonce; false = replay or no store.
		$claim = self::$claim_nonce ?? static function ( string $nonce, int $ttl ): bool {
			if ( ! Core::$memd instanceof \Memcached ) {
				Core::print_less_often( 'Command_Auth: no memcache handle; refusing command (single-use unverifiable)' );
				return false;
			}
			return Core::$memd->add( 'nodes-cmd-nonce:' . $nonce, 1, $ttl );
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
