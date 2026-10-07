<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Rate_Limit;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * The rolling, atomic rate limit: `$burst` slots per name, each claimed with
 * the shared cache's `add()` and expiring `$window_s` after its claim.
 */
#[CoversClass( Rate_Limit::class )]
class RateLimitTest extends TestCase {

	private const NAME = 'probe:4471';

	private const BURST = 5;

	private const WINDOW_S = 6;

	private InMemoryMemcached $memd;

	protected function setUp(): void {
		parent::setUp();
		$this->memd = new InMemoryMemcached();
		Core::$memd = $this->memd;
	}

	/** How many of `$calls` claims on NAME the limit admits. */
	private function admitted( int $calls, string $name = self::NAME ): int {
		$admitted = 0;
		for ( $i = 0; $i < $calls; $i++ ) {
			if ( Rate_Limit::ADMITTED === Rate_Limit::claim( $name, self::BURST, self::WINDOW_S ) ) {
				++$admitted;
			}
		}
		return $admitted;
	}

	/** Pins the cache's expiry clock, which is the window's only clock. */
	private function at( int $now ): void {
		$this->memd->clock = static fn (): int => $now;
	}

	public function test_the_burst_is_admitted_and_the_next_call_throttled(): void {
		$this->at( 1_800_000_000 );
		$this->assertSame( self::BURST, $this->admitted( self::BURST ) );

		$this->assertSame( Rate_Limit::THROTTLED, Rate_Limit::claim( self::NAME, self::BURST, self::WINDOW_S ) );
	}

	/**
	 * The budget is the claims of the trailing window, so a burst just before a
	 * boundary still counts just after it, and each claim's room returns one
	 * window after that claim alone.
	 */
	public function test_the_window_rolls_with_each_call_rather_than_resetting(): void {
		$this->at( 1_800_000_001 );
		$this->assertSame( 2, $this->admitted( 2 ) );
		$this->at( 1_800_000_005 );
		$this->assertSame( 3, $this->admitted( 4 ) );

		$this->at( 1_800_000_006 );
		$this->assertSame( 0, $this->admitted( 2 ), 'a boundary frees nothing' );

		$this->at( 1_800_000_007 );
		$this->assertSame( 2, $this->admitted( 4 ), 'the first two claims have aged out, alone' );

		$this->at( 1_800_000_011 );
		$this->assertSame( 3, $this->admitted( 4 ) );
	}

	/**
	 * Admission is the atomic claim, never the read before it: a read that
	 * misses slots another request holds still admits nobody past the budget.
	 */
	public function test_a_stale_read_cannot_admit_past_the_budget(): void {
		$this->assertSame( self::BURST, $this->admitted( self::BURST ) );
		foreach ( $this->memd->keys() as $key ) {
			$this->memd->fail_next_get( $key, \Memcached::RES_NOTFOUND );
		}

		$this->assertSame( Rate_Limit::THROTTLED, Rate_Limit::claim( self::NAME, self::BURST, self::WINDOW_S ) );
	}

	/**
	 * A read that misses one held slot costs that slot's refused `add()`, and
	 * the claim walks on to the first slot that really is free.
	 */
	public function test_a_lost_race_walks_on_to_the_next_free_slot(): void {
		$this->assertSame( 2, $this->admitted( 2 ) );
		$slot = static fn ( int $n ): string => Cache_Backend::site_key( 'rate-limit:' . self::NAME . ":{$n}" );
		$this->memd->fail_next_get( $slot( 0 ), \Memcached::RES_NOTFOUND );

		$this->assertSame( Rate_Limit::ADMITTED, Rate_Limit::claim( self::NAME, self::BURST, self::WINDOW_S ) );
		$this->assertSame( [ $slot( 0 ), $slot( 1 ), $slot( 2 ) ], $this->memd->keys() );
	}

	public function test_each_name_has_a_budget_of_its_own(): void {
		$this->assertSame( self::BURST, $this->admitted( self::BURST + 2 ) );

		$this->assertSame( self::BURST, $this->admitted( self::BURST, 'probe:9302' ) );
	}

	public function test_each_slot_lives_one_window_in_the_install_scope(): void {
		$this->at( 1_800_000_000 );
		$this->admitted( 1 );

		$this->assertSame(
			[ Cache_Backend::site_key( 'rate-limit:' . self::NAME . ':0' ) => 1_800_000_000 + self::WINDOW_S ],
			$this->memd->expiries()
		);
	}

	/**
	 * A cache that cannot answer the slot read cannot meter either: the claim
	 * is unavailable, and spends no slot on a backend already failing.
	 */
	public function test_a_failed_slot_read_is_unavailable_and_claims_nothing(): void {
		$dead       = new class() extends InMemoryMemcached {
			public function getMulti( array $keys, int $get_flags = 0 ): array|false {
				return false;
			}
		};
		Core::$memd = $dead;

		$this->assertSame( Rate_Limit::UNAVAILABLE, Rate_Limit::claim( self::NAME, self::BURST, self::WINDOW_S ) );
		$this->assertSame( [], $dead->keys(), 'no slot was claimed' );
	}

	public function test_a_host_with_no_shared_cache_is_unavailable(): void {
		Core::$memd                 = null;
		Cache_Backend::$apcu_usable = static fn (): bool => false;

		$this->assertSame( Rate_Limit::UNAVAILABLE, Rate_Limit::claim( self::NAME, self::BURST, self::WINDOW_S ) );
	}

	public function test_a_burst_below_one_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		Rate_Limit::claim( self::NAME, 0, self::WINDOW_S );
	}

	public function test_a_burst_at_the_ceiling_is_admitted(): void {
		$this->assertSame( Rate_Limit::ADMITTED, Rate_Limit::claim( self::NAME, Rate_Limit::MAX_BURST, self::WINDOW_S ) );
	}

	/** The burst is the width of every slot read, so it is bounded. */
	public function test_a_burst_above_the_ceiling_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		Rate_Limit::claim( self::NAME, Rate_Limit::MAX_BURST + 1, self::WINDOW_S );
	}

	/** Every write refuses a key holding whitespace, so no slot could be claimed. */
	public function test_a_name_holding_whitespace_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		Rate_Limit::claim( "probe 4471", self::BURST, self::WINDOW_S );
	}

	/** An unmetered door says so once a window, whatever the call count. */
	public function test_admitting_unmetered_warns_once_per_door(): void {
		$lines = [];
		Core::set_stderr_handler( static function ( string $text ) use ( &$lines ): void {
			$lines[] = $text;
		} );

		$this->assertTrue( Rate_Limit::admit_unmetered( 'probe-door' ) );
		$this->assertTrue( Rate_Limit::admit_unmetered( 'probe-door' ) );
		$this->assertTrue( Rate_Limit::admit_unmetered( 'other-door' ) );

		$this->assertCount( 1, \array_filter( $lines, static fn ( string $l ): bool => \str_contains( $l, 'probe-door rate limit unavailable' ) ) );
		$this->assertCount( 1, \array_filter( $lines, static fn ( string $l ): bool => \str_contains( $l, 'other-door rate limit unavailable' ) ) );
	}

	/** A zero ttl would store the slot forever, so the name never recovers. */
	public function test_a_window_below_one_second_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		Rate_Limit::claim( self::NAME, self::BURST, 0 );
	}
}
