<?php
/**
 * Sse_Slot_Pool: generic SSE concurrency cap backed by Memcached when
 * configured, with APCu as the single-host fallback.
 *
 * Each slot has a permanent integer pointer: a positive owner or the reserved
 * tombstone 0. Each owner has a separate expiring liveness key. Atomic add/CAS
 * claims fence stale connections: check, touch, and release operate only on
 * the exact lease returned by acquire().
 *
 * Fail-CLOSED on acquire/check/touch (no backend → ownership is unverifiable)
 * and fail-OPEN on release (leases TTL out anyway).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\SSE_Out_Node;

\defined( 'ABSPATH' ) || exit;

class SSE_Slot_Pool {

	/** Maximum concurrent SSE streams per user/IP per pool. */
	public static int $max_slots = 10;

	/** Slot TTL (seconds). Must outlive the client's session-forget threshold. */
	public static int $ttl = 60;

	/**
	 * Install the four `SSE_Out` slot-pool seams. Idempotent. Call from the
	 * application bootstrap once the cache backends are initialized.
	 */
	public static function wire(): void {
		SSE_Out_Node::$acquire_slot = static function ( int $_partition = -1 ): array|false {
			return self::acquire( self::namespace_key(), self::user_id(), self::ip_hash(), self::$max_slots, self::$ttl );
		};
		SSE_Out_Node::$release_slot = static function ( array $lease, int $_partition = -1 ): void {
			$lease = self::require_lease( $lease );
			self::release( self::namespace_key(), self::user_id(), self::ip_hash(), $lease['slot'], $lease['owner'] );
		};
		SSE_Out_Node::$check_slot = static function ( array $lease, int $_partition = -1 ): bool {
			// Check-only, NEVER refresh TTL here (only client heartbeat does).
			$lease = self::require_lease( $lease );
			return self::check( self::namespace_key(), self::user_id(), self::ip_hash(), $lease['slot'], $lease['owner'] );
		};
		SSE_Out_Node::$inspect_slot = static function ( array $lease, int $_partition = -1 ): array {
			$lease = self::require_lease( $lease );
			return self::inspect( self::namespace_key(), self::user_id(), self::ip_hash(), $lease['slot'], $lease['owner'] );
		};
	}

	/**
	 * 8-character md5 of REMOTE_ADDR — a cache-key shard only, never displayed
	 * or stored on disk.
	 */
	public static function ip_hash(): string {
		// phpcs:ignore WordPressVIPMinimum.Variables.ServerVariables.UserControlledHeaders, WordPressVIPMinimum.Variables.RestrictedVariables.cache_constraints___SERVER__REMOTE_ADDR__, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
		return \substr( \md5( Core::as_string( $ip, 'unknown' ) ), 0, 8 );
	}

	public static function user_id(): int {
		return \function_exists( 'get_current_user_id' ) ? \get_current_user_id() : 0;
	}

	/**
	 * The pool namespace: this SITE on this MACHINE.
	 *
	 * @longform Neither half identifies the protected resource alone, and the
	 * two deployments fail in opposite directions. On Atomic one pool host
	 * serves many sites, so a machine-only key put 15 of them on one 10-slot
	 * budget. In dndocker one site spans many containers over a shared database
	 * and memcached, so a site-only key would collapse those instead. Each
	 * environment gets its discriminator from whichever half actually varies.
	 * Neither is caller-controllable — `SERVER_NAME` would be, and a rate-limit
	 * namespace the caller chooses is not a rate limit.
	 */
	public static function namespace_key(): string {
		return self::hostname() . ':' . self::site();
	}

	/** Per-site half of the namespace. Hashed for length; `home_url` is not secret. */
	private static function site(): string {
		return \substr( \md5( \home_url() ), 0, 12 );
	}

	/**
	 * Machine half of the slot key — see namespace_key() for why it is only a
	 * half. Falls back to 'unknown' so a gethostname() failure can never pass
	 * false to the string-typed callees.
	 */
	private static function hostname(): string {
		return \gethostname() ?: 'unknown';
	}

	/**
	 * Claim the first free or dead slot. Fail-CLOSED: no backend returns false
	 * so the caller refuses the connection (HTTP 429).
	 *
	 * @return array{slot:int,owner:int}|false Lease, or false if all slots are live / no store.
	 */
	public static function acquire( string $namespace, int $user_id, string $ip_hash, int $max_slots, int $ttl ): array|false {
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return false;
		}

		for ( $slot = 0; $slot < $max_slots; $slot++ ) {
			$owner       = \random_int( 1, \PHP_INT_MAX );
			$pointer_key = self::slot_key( $namespace, $user_id, $ip_hash, $slot );
			$lease_key   = self::lease_key( $pointer_key, $owner );

			// Publish liveness before the pointer can advertise this owner.
			if ( ! $backend->add( $lease_key, 1, $ttl ) ) {
				continue;
			}

			$pointer = $backend->read( $pointer_key );
			if ( Cache_Backend::READ_MISS === $pointer['status'] ) {
				$claimed = $backend->add( $pointer_key, $owner, 0 );
			} elseif ( Cache_Backend::READ_HIT === $pointer['status'] && \is_int( $pointer['value'] ) ) {
				$current_owner = $pointer['value'];
				if ( 0 === $current_owner ) {
					$claimed = $backend->compare_and_swap( $pointer_key, 0, $owner );
				} elseif ( $current_owner > 0 ) {
					$current_liveness = $backend->read( self::lease_key( $pointer_key, $current_owner ) );
					if ( Cache_Backend::READ_HIT === $current_liveness['status'] ) {
						$backend->delete( $lease_key );
						continue;
					}
					if ( Cache_Backend::READ_MISS !== $current_liveness['status'] ) {
						$backend->delete( $lease_key );
						continue;
					}
					$claimed = $backend->compare_and_swap( $pointer_key, $current_owner, $owner );
				} else {
					$backend->delete( $lease_key );
					continue;
				}
			} else {
				$claimed = false;
			}

			if (
				! $claimed
				|| ! self::pointer_matches( $backend, $pointer_key, $owner )
			) {
				$backend->delete( $lease_key );
				continue;
			}

			$staged_liveness = $backend->read( $lease_key );
			if (
				Cache_Backend::READ_HIT !== $staged_liveness['status']
				|| ! self::pointer_matches( $backend, $pointer_key, $owner )
			) {
				$backend->delete( $lease_key );
				continue;
			}

			return [
				'slot'  => $slot,
				'owner' => $owner,
			];
		}
		return false;
	}

	/**
	 * Inspect one failed lease check with fresh, read-only cache operations.
	 *
	 * This is deliberately separate from the hot-path check. A fully healthy
	 * result means the lease recovered between that failed check and inspection.
	 *
	 * @return array<string,int|string>
	 */
	public static function inspect( string $namespace, int $user_id, string $ip_hash, int $slot, int $owner ): array {
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return [
				'backend'    => 'unavailable',
				'lease_state' => 'backend_read_error',
			];
		}

		$pointer_key = self::slot_key( $namespace, $user_id, $ip_hash, $slot );
		$pointer     = $backend->read( $pointer_key );
		if ( Cache_Backend::READ_ERROR === $pointer['status'] ) {
			return self::inspection_result( $backend, 'backend_read_error' );
		}
		if ( Cache_Backend::READ_MISS === $pointer['status'] ) {
			return self::inspection_result( $backend, 'pointer_missing' );
		}
		if ( $owner !== $pointer['value'] ) {
			return self::inspection_result( $backend, self::mismatch_state( $pointer['value'] ) );
		}

		$liveness = $backend->read( self::lease_key( $pointer_key, $owner ) );
		if ( Cache_Backend::READ_ERROR === $liveness['status'] ) {
			return self::inspection_result( $backend, 'backend_read_error' );
		}
		if ( Cache_Backend::READ_MISS === $liveness['status'] ) {
			return self::inspection_result( $backend, 'liveness_missing' );
		}

		$pointer = $backend->read( $pointer_key );
		if ( Cache_Backend::READ_ERROR === $pointer['status'] ) {
			return self::inspection_result( $backend, 'backend_read_error' );
		}
		if ( Cache_Backend::READ_MISS === $pointer['status'] ) {
			return self::inspection_result( $backend, 'pointer_missing' );
		}
		if ( $owner !== $pointer['value'] ) {
			return self::inspection_result( $backend, self::mismatch_state( $pointer['value'] ) );
		}
		return self::inspection_result( $backend, 'recovered_during_inspection' );
	}

	/**
	 * Which kind of not-ours a pointer holding someone else's value is.
	 *
	 * @longform The tombstone is not a takeover. `release()` CAS's the pointer
	 * to 0, so an idle stream ending its own slot leaves exactly this, and a
	 * client heartbeat already in flight lands on it — routine, and constant
	 * when the idle timeout is shorter than the heartbeat interval. A positive
	 * owner is the real thing: our lease TTL expired and a rival claimed it.
	 *
	 * @param mixed $pointer_value The pointer's current value.
	 */
	private static function mismatch_state( mixed $pointer_value ): string {
		return 0 === $pointer_value ? 'slot_released' : 'pointer_owner_mismatch';
	}

	/** @return array<string,int|string> */
	private static function inspection_result( Cache_Backend $backend, string $lease_state ): array {
		$result = [
			'backend'    => $backend->backend_name(),
			'lease_state' => $lease_state,
		];
		if ( 'apcu' === $result['backend'] || 'backend_read_error' === $lease_state ) {
			$result = \array_merge( $result, $backend->diagnostic_metadata() );
		}
		return $result;
	}

	/** Whether the exact lease is still held (no TTL refresh). Fail-CLOSED. */
	public static function check( string $namespace, int $user_id, string $ip_hash, int $slot, int $owner ): bool {
		if ( $owner <= 0 ) {
			return false;
		}
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return false;
		}
		$pointer_key = self::slot_key( $namespace, $user_id, $ip_hash, $slot );
		if ( ! self::pointer_matches( $backend, $pointer_key, $owner ) ) {
			return false;
		}
		$liveness = $backend->read( self::lease_key( $pointer_key, $owner ) );
		return Cache_Backend::READ_HIT === $liveness['status']
			&& self::pointer_matches( $backend, $pointer_key, $owner );
	}

	/** Tombstone this exact owner, then remove its liveness. Fail-OPEN without a backend. */
	public static function release( string $namespace, int $user_id, string $ip_hash, int $slot, int $owner ): bool {
		if ( $owner <= 0 ) {
			return false;
		}
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return true;
		}
		$pointer_key = self::slot_key( $namespace, $user_id, $ip_hash, $slot );
		if ( ! $backend->compare_and_swap( $pointer_key, $owner, 0 ) ) {
			return false;
		}
		$backend->delete( self::lease_key( $pointer_key, $owner ) );
		return true;
	}

	/**
	 * Validate the lease again at the pool seam boundary.
	 *
	 * @param array<array-key,mixed> $lease Candidate lease from the endpoint.
	 * @return array{slot:int,owner:int}
	 */
	private static function require_lease( array $lease ): array {
		if (
			2 !== \count( $lease )
			|| ! \array_key_exists( 'slot', $lease )
			|| ! \array_key_exists( 'owner', $lease )
			|| ! \is_int( $lease['slot'] )
			|| 0 > $lease['slot']
			|| ! \is_int( $lease['owner'] )
			|| 0 >= $lease['owner']
		) {
			throw new \UnexpectedValueException( 'SSE slot seam did not receive a complete lease.' );
		}
		return [
			'slot'  => $lease['slot'],
			'owner' => $lease['owner'],
		];
	}

	/** Refresh the exact lease TTL. Fail-CLOSED when ownership is unverifiable. */
	public static function touch( string $namespace, int $user_id, string $ip_hash, int $slot, int $owner, int $ttl ): bool {
		if ( $owner <= 0 ) {
			return false;
		}
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return false;
		}
		$pointer_key = self::slot_key( $namespace, $user_id, $ip_hash, $slot );
		$lease_key   = self::lease_key( $pointer_key, $owner );
		if ( ! self::pointer_matches( $backend, $pointer_key, $owner ) ) {
			return false;
		}
		if ( ! $backend->touch( $lease_key, $ttl ) ) {
			return false;
		}

		$pointer = $backend->read( $pointer_key );
		if ( Cache_Backend::READ_HIT === $pointer['status'] && $owner === $pointer['value'] ) {
			return true;
		}
		$backend->delete( $lease_key );
		return false;
	}

	/**
	 * Whether a confirmed pointer read names the exact owner.
	 *
	 * @phpstan-impure The external cache can change between consecutive reads.
	 */
	private static function pointer_matches( Cache_Backend $backend, string $pointer_key, int $owner ): bool {
		$pointer = $backend->read( $pointer_key );
		return Cache_Backend::READ_HIT === $pointer['status'] && $owner === $pointer['value'];
	}

	/** Owner-specific liveness key for one slot pointer. */
	private static function lease_key( string $pointer_key, int $owner ): string {
		return "{$pointer_key}:lease:{$owner}";
	}

	/**
	 * Permanent slot-pointer key. The configured slot count bounds pointers
	 * within each host/user/IP namespace; liveness lives only in lease keys.
	 */
	private static function slot_key( string $namespace, int $user_id, string $ip_hash, int $slot ): string {
		return "newspack_nodes:sse:v2:{$namespace}:{$user_id}:{$ip_hash}:{$slot}";
	}
}
