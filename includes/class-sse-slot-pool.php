<?php
/**
 * Sse_Slot_Pool: generic SSE concurrency cap, keyed directly off the shared
 * `Core::$memd` handle.
 *
 * Owns the atomic add()-loop slot claim: `acquire()` walks slots 0..max and
 * `\Memcached::add()`s the first free one (add is atomic — only succeeds if
 * the key is absent), so concurrent connections can't grab the same slot.
 * `wire()` installs the three `SSE_Out` Closure seams so the unified SSE
 * endpoint inherits the cap; the client's `workers/heartbeat` poke refreshes
 * the slot via `touch()`.
 *
 * Fail-CLOSED on the acquire/check path (no memcache → refuse the connection)
 * and fail-OPEN on release/touch (slots TTL out anyway).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\SSE_Out_Node;

\defined( 'ABSPATH' ) || exit;

class SSE_Slot_Pool {

	/** Maximum concurrent SSE streams per user/IP per pool. */
	public static int $max_slots = 10;

	/** Slot TTL (seconds) */
	public static int $ttl = 30;

	/**
	 * Install the three `SSE_Out` slot-pool seams. Idempotent. Call from the
	 * application bootstrap once `Core::$memd` is set.
	 */
	public static function wire(): void {
		SSE_Out_Node::$acquire_slot = static function (): int|false {
			return self::acquire( self::user_id(), self::ip_hash(), self::$max_slots, self::$ttl );
		};
		SSE_Out_Node::$release_slot = static function ( int $slot ): void {
			self::release( self::user_id(), self::ip_hash(), $slot );
		};
		SSE_Out_Node::$check_slot = static function ( int $slot ): bool {
			// Check-only — NEVER refresh the TTL here. The slot TTL is refreshed
			// EXCLUSIVELY by the client's periodic `workers/heartbeat` poke
			// (Workers_CI -> Sse_Slot_Pool::touch). A stream draining is not proof
			// the browser is alive; refresh-on-check would let a zombie connection
			// hold a slot indefinitely, defeating the rate-limit invariant.
			return self::check( self::user_id(), self::ip_hash(), $slot );
		};
	}

	/**
	 * Claim the first free slot via atomic add(). Fail-CLOSED: null handle
	 * returns false so the caller refuses the connection (HTTP 429).
	 *
	 * @return int|false Slot index 0..max_slots-1, or false if all taken / no memcache.
	 */
	public static function acquire( int $user_id, string $ip_hash, int $max_slots, int $ttl ): int|false {
		if ( null === Core::$memd ) {
			return false;
		}
		// Opaque per-connection marker; only its presence (not value) is read.
		$connection_id = \bin2hex( \random_bytes( 8 ) );
		for ( $slot = 0; $slot < $max_slots; $slot++ ) {
			$key = self::slot_key( $user_id, $ip_hash, $slot );
			if ( Core::$memd->add( $key, $connection_id, $ttl ) ) {
				return $slot;
			}
		}
		return false;
	}

	/**
	 * Slot cache key.
	 */
	private static function slot_key( int $user_id, string $ip_hash, int $slot ): string {
		return "evlog:sse:{$user_id}:{$ip_hash}:{$slot}";
	}

	public static function user_id(): int {
		return \function_exists( 'get_current_user_id' ) ? \get_current_user_id() : 0;
	}

	/**
	 * 8-character md5 of REMOTE_ADDR — a cache-key shard only, never displayed
	 * or stored on disk.
	 */
	public static function ip_hash(): string {
		// phpcs:ignore WordPressVIPMinimum.Variables.ServerVariables.UserControlledHeaders, WordPressVIPMinimum.Variables.RestrictedVariables.cache_constraints___SERVER__REMOTE_ADDR__, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
		return \substr( \md5( \is_scalar( $ip ) ? (string) $ip : 'unknown' ), 0, 8 );
	}

	/** Release a slot. Fail-OPEN (slots auto-expire via TTL). */
	public static function release( int $user_id, string $ip_hash, int $slot ): bool {
		if ( null === Core::$memd ) {
			return true;
		}
		return Core::$memd->delete( self::slot_key( $user_id, $ip_hash, $slot ) );
	}

	/** Whether the slot is still held (no TTL refresh). Fail-CLOSED. */
	public static function check( int $user_id, string $ip_hash, int $slot ): bool {
		if ( null === Core::$memd ) {
			return false;
		}
		return false !== Core::$memd->get( self::slot_key( $user_id, $ip_hash, $slot ) );
	}

	/** Refresh slot TTL (client heartbeat). Fail-OPEN (true when no memcache). */
	public static function touch( int $user_id, string $ip_hash, int $slot, int $ttl ): bool {
		if ( null === Core::$memd ) {
			return true;
		}
		return Core::$memd->touch( self::slot_key( $user_id, $ip_hash, $slot ), $ttl );
	}
}
