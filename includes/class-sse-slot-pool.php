<?php
/**
 * SSE_Slot_Pool: the concurrency cap on Server-Sent Events streams, backed by
 * memcached where it is configured and by APCu on a single host.
 *
 * Each slot has a permanent integer pointer holding a positive owner or the
 * reserved tombstone 0, and each owner has a separate expiring liveness key.
 * Atomic add and compare-and-swap claims fence stale connections, and check,
 * touch and release act only on the exact lease acquire() returned.
 *
 * Acquire, check and touch fail CLOSED: with no backend, ownership is
 * unverifiable and the caller must refuse. Release fails OPEN, because a lease
 * expires on its own.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\SSE_Out_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * All static: a claim has to be readable from a web request, a worker and
 * WP-CLI without wiring a node, and there is no per-process state to hold.
 *
 * Every operation takes the pool namespace and the bounds as arguments instead
 * of reading configuration itself, so `wire()` is the one place production
 * resolves them and a test picks its own scope without touching options.
 */
class SSE_Slot_Pool {

	/** @api Tests override; production reads config through max_slots(). */
	public static ?int $max_slots = null;

	/** @api Tests override; production reads config through ttl(). */
	public static ?int $ttl = null;

	/** @api Tests override; production reads config through max_streams(). */
	public static ?int $max_streams = null;

	/** @api Tests override; production reads config through reserved_slots(). */
	public static ?int $reserved_slots = null;

	/**
	 * One reader's share of the host total: the override, else config, never
	 * more than the whole host, since a share that cannot bind is not a share.
	 *
	 * A per-identity cap bounds one reader and never the host; `max_streams()`
	 * is what protects the site. The shipped 3 leaves room for an idle stream
	 * reopening on the `sse_idle_timeout` plus `sse_retry_ms` cycle while its
	 * dead lease still holds a slot.
	 *
	 * @return int Slots one identity may hold at once, at least 1.
	 */
	public static function max_slots(): int {
		return self::$max_slots
			?? \min(
				self::max_streams(),
				\max( 1, self::budget( 'sse_max_slots' ) )
			);
	}

	/**
	 * Host slots browsers may not claim: the override, else config, never the
	 * whole host, since reserving every slot locks out the readers the host
	 * exists to serve.
	 *
	 * A reservation comes OUT of the host total, not on top of it: it raises
	 * nobody's ceiling, it only decides who may reach the last slot. Meaningful
	 * only where something machine-driven pulls from this host — a spoke sets 1
	 * so the hub's aggregation pull always finds a slot.
	 *
	 * @return int Trailing slots held back from browsers, always leaving at least one claimable.
	 */
	public static function reserved_slots(): int {
		return self::$reserved_slots
			?? \min(
				self::max_streams() - 1,
				\max( 0, self::budget( 'sse_reserved_slots' ) )
			);
	}

	/**
	 * Whole-host concurrent-stream cap: the override, else config.
	 *
	 * This is the cap that protects the site; the per-identity one only divides
	 * it fairly. An SSE stream occupies a php-fpm child for its entire life, and
	 * Atomic replies 599 once PHP requests backlog, which puts the EDGE into
	 * auto-defensive mode for 60s for every visitor. The shipped 6 leaves room
	 * in a ~10-worker allocation for page requests and the node worker itself.
	 * See docs/sse-host-budget.md.
	 *
	 * @return int Concurrent streams this host allows, at least 1.
	 */
	public static function max_streams(): int {
		return self::$max_streams
			?? \max( 1, self::budget( 'sse_max_streams' ) );
	}

	/**
	 * Install the four `SSE_Out_Node` slot-pool seams. Idempotent. Call from the
	 * application bootstrap once the cache backends are initialized.
	 *
	 * The seams close over the production namespace and bounds, so the endpoint
	 * carries no pool configuration of its own. They ignore the partition it
	 * offers, because slots are pooled host-wide and a pool per partition would
	 * multiply the host cap by the partition count.
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
	 * Lease TTL in seconds: the override, else config, floored at the re-auth
	 * window. A configured value below it is raised, not honoured.
	 *
	 * That floor is THREE `Remote_Link_Node::HEARTBEAT_INTERVAL`s, not two. Only
	 * an owner-matched `workers heartbeat` refreshes a lease — `check()` never
	 * does — and a client that loses its session stops heartbeating for the
	 * whole re-auth round trip, so a TTL sized for heartbeat loss alone fences a
	 * stream that is merely re-authenticating. Shortening it to reclaim crashed
	 * readers faster is tempting once the pool is small; 45 is the wall.
	 *
	 * @return int Lease lifetime in seconds, never under the 45-second floor.
	 */
	public static function ttl(): int {
		return self::$ttl
			?? \max(
				3 * Remote_Link_Node::HEARTBEAT_INTERVAL,
				self::budget( 'sse_slot_ttl' )
			);
	}

	/**
	 * A budget knob, falling back to the value the SCHEMA declares (ADR-20).
	 *
	 * `Config_Utils::validate_config_values()` accepts null and `Core::num_int`
	 * defaults to 0, so reading these unguarded lets an operator's blank entry
	 * silently collapse the host cap to 1 rather than hold the platform budget
	 * the knob documents.
	 *
	 * @param string $key One of the four sse_* budget keys this class reads.
	 * @return int Configured value, else the default the schema declares.
	 */
	private static function budget( string $key ): int {
		$declared = Settings_Schema::get()->defaults()[ $key ];
		return Core::num_int( Config::value( $key ), Core::num_int( $declared ) );
	}

	/**
	 * Who holds a stream. Slots are pooled host-wide, so this rides in the lease
	 * VALUE and bounds one reader's share instead of splitting the pool.
	 *
	 * @return string `{user id}:{ip hash}`, the value every lease key stores.
	 */
	public static function identity(): string {
		return self::user_id() . ':' . self::ip_hash();
	}

	/**
	 * 8-character md5 of REMOTE_ADDR — a cache-key shard only, never displayed
	 * or stored on disk.
	 *
	 * @return string Eight hex characters.
	 */
	public static function ip_hash(): string {
		// phpcs:ignore WordPressVIPMinimum.Variables.ServerVariables.UserControlledHeaders, WordPressVIPMinimum.Variables.RestrictedVariables.cache_constraints___SERVER__REMOTE_ADDR__, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
		return \substr( \md5( Core::as_string( $ip, 'unknown' ) ), 0, 8 );
	}

	/** The current user, or 0 outside a WP runtime. Pairs with the IP hash. */
	public static function user_id(): int {
		return \function_exists( 'get_current_user_id' ) ? \get_current_user_id() : 0;
	}

	/**
	 * The pool namespace: this SITE on this MACHINE — both halves from
	 * `Cache_Backend`, which owns key scope for every surface.
	 *
	 * Neither half identifies the protected resource alone, and the two
	 * deployments fail in opposite directions. On Atomic one pool host serves
	 * many sites, so a machine-only key would put 15 of them on one 10-slot
	 * budget.
	 * In dndocker one site spans many containers over a shared database and
	 * memcached, so a site-only key would collapse those instead. This is the
	 * only surface that wants the machine: everything else is site-scoped,
	 * because the hostname fragments what a fleet must agree on.
	 *
	 * @return string `{machine}:{site}`, the scope half of every pool key.
	 */
	public static function namespace_key(): string {
		return Cache_Backend::machine() . ':' . Cache_Backend::site();
	}

	/**
	 * Claim the first free or dead slot, fencing every stale owner it passes.
	 * Fail-CLOSED: with no backend this returns false and the caller refuses the
	 * connection (HTTP 429).
	 *
	 * The liveness key is added BEFORE the pointer can name this owner. Reverse
	 * the order and a rival reading the pointer between the two writes finds an
	 * owner carrying no liveness key, judges the slot dead and reclaims it.
	 *
	 * After the claim the pointer is confirmed, the staged liveness is
	 * confirmed, and the pointer is confirmed again. A rival can move the
	 * pointer between any two operations and the store can evict the fresh
	 * liveness key, so a lease is handed back only once all three reads agree.
	 * Every path that gives up deletes its own staged liveness first, rather
	 * than leaving a key that makes a free slot look held for a whole TTL.
	 *
	 * @param string $namespace        Pool scope; production passes `namespace_key()`.
	 * @param string $identity         Holder to record in the lease value, from `identity()`.
	 * @param int    $max_streams      Whole-host pointer count: the cap that binds.
	 * @param int    $max_per_identity Slots one identity may hold at once.
	 * @param int    $ttl              Lease lifetime in seconds.
	 * @param int    $reserved         Trailing slots this caller may not claim.
	 * @return array{slot:int,owner:int}|false Lease, or false when the identity is at its share, every claimable slot is live, or no store answered.
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
	 *
	 * @param Cache_Backend $backend     The caller's selected tier, so the count and the claim cannot straddle tiers.
	 * @param string        $namespace   Pool scope.
	 * @param string        $identity    Holder to count, as the lease values store it.
	 * @param int           $max_streams Pointers to scan: the whole host.
	 * @return int Live slots this identity holds.
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
	 *
	 * @return bool True when the request carries the `X-Newspack-Nodes-Pull` header.
	 */
	public static function is_machine_pull(): bool {
		// phpcs:ignore WordPressVIPMinimum.Variables.RestrictedVariables.cache_constraints___SERVER__HTTP_USER_AGENT__, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		return '' !== Core::as_string( $_SERVER['HTTP_X_NEWSPACK_NODES_PULL'] ?? '', '' );
	}

	/**
	 * Name why one lease check failed, with fresh, read-only cache operations.
	 *
	 * Deliberately separate from the hot-path check, which reports one bool for
	 * six distinct states: `backend_read_error`, `pointer_missing`,
	 * `slot_released`, `pointer_owner_mismatch`, `liveness_missing` and
	 * `recovered_during_inspection`. The last means the lease came back between
	 * the failed check and this read, so a heartbeat may simply retry.
	 *
	 * @param string $namespace Pool scope; production passes `namespace_key()`.
	 * @param int    $slot      Slot the failed lease names.
	 * @param int    $owner     Owner the failed lease names.
	 * @return array<string,int|string> `backend` and `lease_state`, plus the backend's diagnostic facts on APCu or a read error.
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
	 * @return string Either `slot_released` or `pointer_owner_mismatch`.
	 */
	private static function mismatch_state( mixed $pointer_value ): string {
		return 0 === $pointer_value ? 'slot_released' : 'pointer_owner_mismatch';
	}

	/**
	 * One inspection verdict, plus the backend facts that explain it.
	 *
	 * Those facts ride along for APCu, whose expunge and free-memory numbers say
	 * whether the segment is thrashing, and for any read error, whose memcached
	 * result code names the failure. A healthy memcached read needs neither.
	 *
	 * @param Cache_Backend $backend     Tier the inspection read through.
	 * @param string        $lease_state Verdict for the inspected lease.
	 * @return array<string,int|string>
	 */
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

	/**
	 * Whether the exact lease is still held. Fail-CLOSED.
	 *
	 * Never refreshes the TTL. Only an owner-matched `workers heartbeat` does,
	 * so a client that has stopped heartbeating loses its slot on schedule
	 * however long its stream stays open. The pointer is read again after the
	 * liveness read, because a rival can reclaim the slot between the two.
	 *
	 * @param string $namespace Pool scope.
	 * @param int    $slot      Slot from the lease.
	 * @param int    $owner     Owner from the lease.
	 * @return bool True only when the pointer names this owner and its liveness key is present.
	 */
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

	/**
	 * Tombstone this exact owner, then remove its liveness. Fail-OPEN without a
	 * backend, since the lease expires on its own.
	 *
	 * The CAS is what makes a stale release harmless: an owner that already lost
	 * the slot cannot tombstone its successor. The pointer goes to 0 rather than
	 * being deleted, so the slot keeps a pointer for the next claimant to swap,
	 * and 0 itself is refused as an owner — it is the tombstone, not a holder.
	 *
	 * @param string $namespace Pool scope.
	 * @param int    $slot      Slot from the lease.
	 * @param int    $owner     Owner from the lease.
	 * @return bool True when the tombstone landed or no backend answered; false on a non-positive owner or a pointer that no longer names this one.
	 */
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
	 * The endpoint carries one lease through its whole drain loop and hands it
	 * back on every check and on release, so the shape is asserted here rather
	 * than trusted: exactly the two keys `acquire()` returned, a non-negative
	 * slot and a positive owner. A malformed lease that slipped through would
	 * check or release whichever slot its numbers happen to name.
	 *
	 * @param array<array-key,mixed> $lease Candidate lease from the endpoint.
	 * @return array{slot:int,owner:int}
	 * @throws \UnexpectedValueException When the candidate is not exactly that shape.
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

	/**
	 * Refresh the exact lease TTL. Fail-CLOSED when ownership is unverifiable.
	 *
	 * The pool's only refresh, reached from the `workers heartbeat` verb, so a
	 * stream lives exactly as long as its client keeps saying so. The pointer is
	 * confirmed before the refresh and again after it; a rival that took the
	 * slot in between leaves this owner's revived liveness key behind, which the
	 * refusal path then deletes.
	 *
	 * @param string $namespace Pool scope.
	 * @param int    $slot      Slot from the lease.
	 * @param int    $owner     Owner from the lease.
	 * @param int    $ttl       New lease lifetime in seconds.
	 * @return bool True when this owner still holds the slot and its lease was extended.
	 */
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
	 * A read error is not a match, which is what makes every caller fail closed:
	 * a backend that cannot answer has not proven the lease is still ours.
	 *
	 * @param Cache_Backend $backend     Tier to read through.
	 * @param string        $pointer_key Slot pointer key.
	 * @param int           $owner       Owner the lease names.
	 * @return bool True only on a confirmed hit holding this owner.
	 *
	 * @phpstan-impure The external cache can change between consecutive reads.
	 */
	private static function pointer_matches( Cache_Backend $backend, string $pointer_key, int $owner ): bool {
		$pointer = $backend->read( $pointer_key );
		return Cache_Backend::READ_HIT === $pointer['status'] && $owner === $pointer['value'];
	}

	/**
	 * Owner-specific liveness key for one slot pointer.
	 *
	 * The owner is in the KEY, not the value, so an expiring lease takes only
	 * its own liveness with it and a successor writes a different key.
	 *
	 * @param string $pointer_key Slot pointer key.
	 * @param int    $owner       Lease owner.
	 * @return string The composed liveness key.
	 */
	private static function lease_key( string $pointer_key, int $owner ): string {
		return "{$pointer_key}:lease:{$owner}";
	}

	/**
	 * Permanent slot-pointer key. ONE pooled keyspace per host, so the pointer
	 * count IS the host cap; liveness and holder live in the lease key.
	 *
	 * @param string $namespace Pool scope, already `machine:site`.
	 * @param int    $slot      Slot index, from 0 up to the host cap.
	 * @return string The composed pointer key.
	 */
	private static function slot_key( string $namespace, int $slot ): string {
		// $namespace IS the scope (machine:site); callers inject their own.
		return Cache_Backend::key( $namespace, "sse:{$slot}" );
	}
}
