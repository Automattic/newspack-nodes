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
	 * @var \Closure|null
	 */
	public static ?\Closure $claim_nonce = null;

	/** Per-site HMAC secret, domain-separated from the spawn token. */
	private static function secret(): string {
		if ( ! \defined( 'NONCE_SALT' ) || '' === (string) \NONCE_SALT ) {
			// Fails OPEN otherwise: a public fallback secret is forgeable by anyone.
			// Warn loudly so the misconfiguration is visible (NONCE_SALT is always
			// set in a normal WordPress install).
			Core::print_less_often( 'Command_Auth: NONCE_SALT is not configured; command signatures use a public fallback secret and are forgeable. Set NONCE_SALT.' );
			$salt = 'fallback-salt-please-set-NONCE_SALT';
		} else {
			$salt = (string) \NONCE_SALT;
		}
		return \hash_hmac( 'sha256', 'nodes-command-v1', $salt );
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

	/**
	 * Stamp an `auth` envelope onto a command Message's VALUE. No-op if VALUE is
	 * not a command struct (no `name`).
	 *
	 * @param array<int,mixed> $message Message (mutated in place).
	 * @param int|null         $now     Signing time; defaults to time().
	 */
	public static function sign( array &$message, ?int $now = null ): void {
		$value = $message[ Message::VALUE ] ?? null;
		if ( ! \is_array( $value ) || ! isset( $value['name'] ) ) {
			return;
		}
		$ts       = $now ?? \time();
		$nonce    = \bin2hex( \random_bytes( 16 ) );
		$type_raw = $message[ Message::TYPE ] ?? 0;
		$canon    = self::canonical( \is_numeric( $type_raw ) ? (int) $type_raw : 0, $value, $ts, $nonce );
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
	 * Verify a command Message's `auth` envelope: freshness window, HMAC, then a
	 * single-use nonce claim. Returns false on any failure (fail closed).
	 *
	 * @param array<int,mixed> $message Message to verify.
	 * @param int|null         $now     Verification time; defaults to time().
	 */
	public static function verify( array $message, ?int $now = null ): bool {
		$value = $message[ Message::VALUE ] ?? null;
		if ( ! \is_array( $value ) || ! isset( $value['name'] ) ) {
			return false;
		}
		$auth = $value['auth'] ?? null;
		if ( ! \is_array( $auth ) || ! isset( $auth['ts'], $auth['nonce'], $auth['sig'] ) ) {
			return false;
		}
		$ts_raw   = $auth['ts'];
		$nonce_in = $auth['nonce'];
		$ts       = \is_numeric( $ts_raw ) ? (int) $ts_raw : 0;
		$nonce    = \is_scalar( $nonce_in ) ? (string) $nonce_in : '';
		$now      = $now ?? \time();

		// Freshness: not stale, not implausibly in the future.
		if ( $now - $ts > self::MAX_PAST_S || $ts - $now > self::MAX_FUTURE_S ) {
			return false;
		}

		$type_raw = $message[ Message::TYPE ] ?? 0;
		$canon    = self::canonical( \is_numeric( $type_raw ) ? (int) $type_raw : 0, $value, $ts, $nonce );
		if ( null === $canon ) {
			return false;
		}
		$expected = \hash_hmac( 'sha256', $canon, self::secret() );
		$sig      = $auth['sig'];
		if ( ! \hash_equals( $expected, \is_scalar( $sig ) ? (string) $sig : '' ) ) {
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
	 */
	public static function verifier(): \Closure {
		return static fn ( array $message ): bool =>
			isset( $message[ Message::LOCAL ] ) || self::verify( $message );
	}
}
