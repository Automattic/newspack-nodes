<?php
/**
 * Rate_Limit: an atomic call budget in the shared cache.
 *
 * A name holds `$burst` slots. An admitted call claims one with the shared
 * cache's atomic `add()` under a `$window_s` TTL, so two concurrent callers
 * cannot both take the last slot, which a transient counter's read-then-write
 * cannot promise. Each slot frees on its own clock rather than at one shared
 * boundary, but the cache counts expiry in whole seconds: memcached frees a
 * slot between `$window_s - 1` and `$window_s` seconds after its claim, and
 * APCu between `$window_s` and `$window_s + 1`. At a one-second window on
 * memcached the budget is therefore close to one bucket per cache tick, and
 * the gain is the atomic claim alone.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Static only: the slots live in the cache, so there is nothing to hold.
 *
 * The answer is one of three constants and never a response, because each
 * door decides for itself what throttled and unavailable mean.
 */
final class Rate_Limit {

	/** `claim()` answer: a slot was claimed, so the call may proceed. */
	public const ADMITTED = 'admitted';

	/** `claim()` answer: every slot is held by a call inside the window. */
	public const THROTTLED = 'throttled';

	/**
	 * `claim()` answer: neither memcached nor APCu answered the slot read, so
	 * nothing can be metered. The door either refuses or `admit_unmetered()`.
	 */
	public const UNAVAILABLE = 'unavailable';

	/**
	 * Most slots one name may hold. Every claim reads all of them in one
	 * `read_multi()`, so the burst is also the width of that read.
	 */
	public const MAX_BURST = 256;

	/** Static only. */
	private function __construct() {}

	/**
	 * Claim one of `$burst` slots under `$name` for `$window_s` seconds.
	 *
	 * One `read_multi()` of the slots chooses which to try, and only the
	 * `add()` decides: a read that missed a slot another request holds costs
	 * one refused `add()` and the claim walks on, never an admission past the
	 * budget. A read that failed outright claims nothing, because the backend
	 * is already failing.
	 *
	 * @param string $name     Caller-scoped logical name, e.g. `command:7`; no whitespace.
	 * @param int    $burst    Calls admitted per window, 1 to MAX_BURST.
	 * @param int    $window_s Slot TTL in seconds, at least 1.
	 * @return self::ADMITTED|self::THROTTLED|self::UNAVAILABLE
	 * @throws \InvalidArgumentException On a burst outside 1..MAX_BURST, a
	 *                                   window below 1, or whitespace in the name.
	 */
	public static function claim( string $name, int $burst, int $window_s ): string {
		if ( $burst < 1 || $burst > self::MAX_BURST || $window_s < 1 ) {
			// A 0 ttl stores a slot forever, so the name would never recover.
			throw new \InvalidArgumentException( "rate limit {$name}: burst {$burst} must be 1 to " . self::MAX_BURST . ", window {$window_s} at least 1" );
		}
		if ( 1 === \preg_match( '/\s/', $name ) ) {
			// Every cache write refuses such a key; no slot could be claimed.
			throw new \InvalidArgumentException( "rate limit name holds whitespace: {$name}" );
		}
		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			return self::UNAVAILABLE;
		}
		$slots = [];
		for ( $slot = 0; $slot < $burst; $slot++ ) {
			$slots[] = Cache_Backend::site_key( "rate-limit:{$name}:{$slot}" );
		}
		$held = $backend->read_multi( $slots, $failed );
		if ( $failed ) {
			return self::UNAVAILABLE;
		}
		foreach ( $slots as $key ) {
			if ( ! \array_key_exists( $key, $held ) && $backend->add( $key, 1, $window_s ) ) {
				return self::ADMITTED;
			}
		}
		return self::THROTTLED;
	}

	/**
	 * Admit a call no shared cache could meter, saying so once a log window
	 * per door. For a door whose loss costs more than an unmetered call.
	 *
	 * @param string $door The door, as the warning names it.
	 * @return true
	 */
	public static function admit_unmetered( string $door ): true {
		Core::print_less_often( "Rate_Limit: {$door} rate limit unavailable (neither memcached nor APCu answered); admitting unmetered" );
		return true;
	}
}
