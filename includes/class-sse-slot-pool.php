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

	/**
	 * Maximum concurrent SSE streams per user/IP, when config says nothing.
	 *
	 * An SSE stream is a SUSTAINED PHP-FPM child, never a bursty one, and a
	 * host tolerates only a handful sustained before the platform starts
	 * refusing requests outright. This cap is per user/IP, so it has never
	 * bounded a host's total — it is the per-reader share of a budget the
	 * global cap owns. Three, because idle streams close and reopen on a
	 * `sse_idle_timeout` + `sse_retry_ms` cycle and a dead lease can linger for
	 * its TTL while the client is already back asking for another.
	 */
	public const DEFAULT_MAX_SLOTS = 3;

	/**
	 * Lease TTL in seconds, when config says nothing.
	 *
	 * The floor is THREE `Remote_Link_Node::HEARTBEAT_INTERVAL`s, not two. Only
	 * an owner-matched `workers heartbeat` refreshes a lease — `check()` never
	 * does — and a client that loses its session stops heartbeating for the
	 * whole re-auth round trip, so a TTL sized for heartbeat loss alone fences
	 * a stream that is merely re-authenticating. Shortening this to reclaim
	 * crashed readers faster is tempting once the pool is small; 45 is the
	 * wall, and the existing test pins it.
	 */
	public const DEFAULT_TTL = 60;

	/**
	 * Concurrent SSE streams for the whole host, when config says nothing.
	 *
	 * This is the cap that actually protects the site; the per-identity one
	 * only divides it fairly. An SSE stream occupies a php-fpm child for its
	 * entire life, and Atomic replies 599 once PHP requests backlog, which puts
	 * the EDGE into auto-defensive mode for 60s for every visitor. Six against
	 * a ~10-worker allocation leaves room for page requests and the worker
	 * itself; burst capacity above the allocation is explicitly not guaranteed,
	 * so it cannot be spent on something sustained. See
	 * docs/sse-host-budget.md.
	 */
	public const DEFAULT_MAX_STREAMS = 6;

	/**
	 * Host slots held back from browsers, when config says nothing.
	 *
	 * Zero, because a reservation is only meaningful where something
	 * machine-driven pulls from this host — a spoke sets 1 so the hub's
	 * aggregation pull always finds a slot. It comes OUT of the host total, not
	 * on top of it: reserving raises nobody's ceiling, it only decides who may
	 * reach the last slot. A pull is otherwise bounded exactly like a browser,
	 * same per-identity share and same TTL.
	 */
	public const DEFAULT_RESERVED_SLOTS = 0;

	/** @api Tests override; production reads config through max_slots(). */
	public static ?int $max_slots = null;

	/** @api Tests override; production reads config through ttl(). */
	public static ?int $ttl = null;

	/** @api Tests override; production reads config through max_streams(). */
	public static ?int $max_streams = null;

	/** @api Tests override; production reads config through reserved_slots(). */
	public static ?int $reserved_slots = null;

	/**
	 * One reader's share: the override, else config, else the default — never
	 * more than the whole host, since a share that cannot bind is not a share.
	 */
	public static function max_slots(): int {
		return self::$max_slots
			?? \min(
				self::max_streams(),
				\max( 1, Core::num_int( Config::value( 'sse_max_slots' ), self::DEFAULT_MAX_SLOTS ) )
			);
	}

	/**
	 * Host slots browsers may not claim: the override, else config, else the
	 * default — never the whole host, since reserving every slot locks out the
	 * readers the host exists to serve.
	 */
	public static function reserved_slots(): int {
		return self::$reserved_slots
			?? \min(
				self::max_streams() - 1,
				\max( 0, Core::num_int( Config::value( 'sse_reserved_slots' ), self::DEFAULT_RESERVED_SLOTS ) )
			);
	}

	/** Whole-host concurrent-stream cap: the override, else config, else the default. */
	public static function max_streams(): int {
		return self::$max_streams
			?? \max( 1, Core::num_int( Config::value( 'sse_max_streams' ), self::DEFAULT_MAX_STREAMS ) );
	}

	/**
	 * Install the four `SSE_Out` slot-pool seams. Idempotent. Call from the
	 * application bootstrap once the cache backends are initialized.
	 */
	public static function wire(): void {
		SSE_Out_Node::$acquire_slot = static function ( int $_partition = -1 ): array|false {
			$reserved = self::is_machine_pull() ? 0 : self::reserved_slots();
			return self::acquire( self::namespace_key(), self::identity(), self::max_streams(), self::max_slots(), self::ttl(), $reserved );
		};
		SSE_Out_Node::$release_slot = static function ( array $lease, int $_partition = -1 ): void {
			$lease = self::require_lease( $lease );
			self::release( self::namespace_key(), $lease['slot'], $lease['owner'] );
		};
		SSE_Out_Node::$check_slot = static function ( array $lease, int $_partition = -1 ): bool {
			// Check-only, NEVER refresh TTL here (only client heartbeat does).
			$lease = self::require_lease( $lease );
			return self::check( self::namespace_key(), $lease['slot'], $lease['owner'] );
		};
		SSE_Out_Node::$inspect_slot = static function ( array $lease, int $_partition = -1 ): array {
			$lease = self::require_lease( $lease );
			return self::inspect( self::namespace_key(), $lease['slot'], $lease['owner'] );
		};
	}

	/**
	 * Lease TTL in seconds: the override, else config, else the default, floored
	 * at the re-auth window. A configured value below it is raised, not honoured
	 * — see DEFAULT_TTL for why 45 is a wall rather than a preference.
	 */
	public static function ttl(): int {
		return self::$ttl
			?? \max(
				3 * Remote_Link_Node::HEARTBEAT_INTERVAL,
				Core::num_int( Config::value( 'sse_slot_ttl' ), self::DEFAULT_TTL )
			);
	}

	/**
	 * Who holds a stream. Slots are pooled host-wide, so this rides in the lease
	 * VALUE and bounds one reader's share instead of splitting the pool.
	 */
	public static function identity(): string {
		return self::user_id() . ':' . self::ip_hash();
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
	 * The pool namespace: this SITE on this MACHINE — both halves from
	 * `Cache_Backend`, which owns key scope for every surface.
	 *
	 * Neither half identifies the protected resource alone, and the two
	 * deployments fail in opposite directions. On Atomic one pool host serves
	 * many sites, so a machine-only key put 15 of them on one 10-slot budget.
	 * In dndocker one site spans many containers over a shared database and
	 * memcached, so a site-only key would collapse those instead. This is the
	 * only surface that wants the machine: everything else is site-scoped,
	 * because the hostname fragments what a fleet must agree on.
	 */
	public static function namespace_key(): string {
		return Cache_Backend::machine() . ':' . Cache_Backend::site();
	}

	/**
	 * Claim the first free or dead slot. Fail-CLOSED: no backend returns false
	 * so the caller refuses the connection (HTTP 429).
	 *
	 * @return array{slot:int,owner:int}|false Lease, or false if all slots are live / no store.
	 */
	public static function acquire( string $namespace, string $identity, int $max_streams, int $max_per_identity, int $ttl, int $reserved = 0 ): array|false {
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return false;
		}
		if ( self::held_by( $backend, $namespace, $identity, $max_streams ) >= $max_per_identity ) {
			return false;
		}

		// Reserved slots are the TAIL, so a browser just stops short.
		$claimable = \max( 1, $max_streams - \max( 0, $reserved ) );
		for ( $slot = 0; $slot < $claimable; $slot++ ) {
			$owner       = \random_int( 1, \PHP_INT_MAX );
			$pointer_key = self::slot_key( $namespace, $slot );
			$lease_key   = self::lease_key( $pointer_key, $owner );

			// Publish liveness before the pointer can advertise this owner.
			if ( ! $backend->add( $lease_key, $identity, $ttl ) ) {
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
	 * How many live host slots this identity already holds.
	 *
	 * Two connections from one identity can both read a stale count and both
	 * claim, overshooting the per-identity cap by the number racing. That is
	 * deliberate: only the HOST cap has to be exact, and it is, because a claim
	 * is a CAS on a fixed number of pointers. Making this exact too would need
	 * a second CAS'd counter to stay consistent with the pointers it describes,
	 * and a wrong count there leaks capacity permanently rather than for one
	 * TTL.
	 *
	 * A read that fails is counted as not-held, so this fails OPEN while the
	 * rest of the class fails closed. That is the safe direction for a SHARE:
	 * the host cap still refuses on its own read errors, so a flapping cache
	 * can let one identity over its share but never over the host's.
	 */
	private static function held_by( Cache_Backend $backend, string $namespace, string $identity, int $max_streams ): int {
		$pointer_keys = [];
		for ( $slot = 0; $slot < $max_streams; $slot++ ) {
			$pointer_keys[] = self::slot_key( $namespace, $slot );
		}

		$lease_keys = [];
		foreach ( $backend->read_multi( $pointer_keys ) as $pointer_key => $owner ) {
			if ( \is_int( $owner ) && 0 < $owner ) {
				$lease_keys[] = self::lease_key( $pointer_key, $owner );
			}
		}

		return [] === $lease_keys
			? 0
			: \count( \array_keys( $backend->read_multi( $lease_keys ), $identity, true ) );
	}

	/**
	 * Whether this request is a machine pull rather than a browser.
	 *
	 * A fairness hint, NOT a security boundary: the endpoint already requires
	 * the READ capability, and any holder of it could send the header. All it
	 * decides is which side of an authorized reader's own budget the request
	 * draws from, so forging it costs a reserved slot and grants no access.
	 * Anything stronger would need the pull to carry a distinct credential,
	 * which is a Vault change, not a slot-pool one.
	 */
	public static function is_machine_pull(): bool {
		// phpcs:ignore WordPressVIPMinimum.Variables.RestrictedVariables.cache_constraints___SERVER__HTTP_USER_AGENT__, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		return '' !== Core::as_string( $_SERVER['HTTP_X_NEWSPACK_NODES_PULL'] ?? '', '' );
	}

	/**
	 * Inspect one failed lease check with fresh, read-only cache operations.
	 *
	 * This is deliberately separate from the hot-path check. A fully healthy
	 * result means the lease recovered between that failed check and inspection.
	 *
	 * @return array<string,int|string>
	 */
	public static function inspect( string $namespace, int $slot, int $owner ): array {
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return [
				'backend'    => 'unavailable',
				'lease_state' => 'backend_read_error',
			];
		}

		$pointer_key = self::slot_key( $namespace, $slot );
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
	 * The tombstone is not a takeover. `release()` CAS's the pointer to 0, so
	 * an idle stream ending its own slot leaves exactly this, and a client
	 * heartbeat already in flight lands on it — routine, and constant when the
	 * idle timeout is shorter than the heartbeat interval. A positive owner is
	 * the real thing: our lease TTL expired and a rival claimed it.
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
	public static function check( string $namespace, int $slot, int $owner ): bool {
		if ( $owner <= 0 ) {
			return false;
		}
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return false;
		}
		$pointer_key = self::slot_key( $namespace, $slot );
		if ( ! self::pointer_matches( $backend, $pointer_key, $owner ) ) {
			return false;
		}
		$liveness = $backend->read( self::lease_key( $pointer_key, $owner ) );
		return Cache_Backend::READ_HIT === $liveness['status']
			&& self::pointer_matches( $backend, $pointer_key, $owner );
	}

	/** Tombstone this exact owner, then remove its liveness. Fail-OPEN without a backend. */
	public static function release( string $namespace, int $slot, int $owner ): bool {
		if ( $owner <= 0 ) {
			return false;
		}
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return true;
		}
		$pointer_key = self::slot_key( $namespace, $slot );
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
	public static function touch( string $namespace, int $slot, int $owner, int $ttl ): bool {
		if ( $owner <= 0 ) {
			return false;
		}
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return false;
		}
		$pointer_key = self::slot_key( $namespace, $slot );
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
	 * Permanent slot-pointer key. ONE pooled keyspace per host, so the pointer
	 * count IS the host cap; liveness and holder live in the lease key.
	 */
	private static function slot_key( string $namespace, int $slot ): string {
		// $namespace IS the scope (machine:site); callers inject their own.
		return Cache_Backend::key( $namespace, "sse:{$slot}" );
	}
}
