<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Failures;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Worker_Should_Stop_Clean;
use Newspack_Nodes\Tests\TestCase;

/**
 * The one rule every attempt-all loop shares (ADR-14): every item is offered,
 * and what it caught combines into the one throwable that escapes. Clean only
 * when every catch was a bare clean stop; a stop when any catch was a stop,
 * carrying every failure; otherwise every failure, propagated.
 */
#[CoversClass( Worker_Should_Stop::class )]
class WorkerShouldStopTest extends TestCase {

	public function test_only_a_bare_clean_stop_is_clean(): void {
		$this->assertTrue( Worker_Should_Stop::is_clean( new Worker_Should_Stop_Clean( 'recycle-17' ) ) );
		$this->assertFalse( Worker_Should_Stop::is_clean( new Worker_Should_Stop_Clean( 'recycle-17', 0, new \RuntimeException( 'flush-18' ) ) ), 'a clean stop carrying a failure is not clean' );
		$this->assertFalse( Worker_Should_Stop::is_clean( new Worker_Should_Stop( 'deadline-19' ) ) );
		$this->assertFalse( Worker_Should_Stop::is_clean( new \RuntimeException( 'poison-20' ) ) );
	}

	public function test_nothing_caught_combines_to_nothing(): void {
		$this->assertNull( Worker_Should_Stop::combine( [] ) );
	}

	public function test_all_clean_stops_combine_to_the_first(): void {
		$first = new Worker_Should_Stop_Clean( 'clean-a' );

		$this->assertSame( $first, Worker_Should_Stop::combine( [ $first, new Worker_Should_Stop_Clean( 'clean-b' ) ] ) );
	}

	public function test_a_clean_stop_beside_a_plain_one_is_the_plain_one_in_either_order(): void {
		$plain = new Worker_Should_Stop( 'deadline-31' );

		$this->assertSame( $plain, Worker_Should_Stop::combine( [ new Worker_Should_Stop_Clean( 'clean-32' ), $plain ] ) );
		$this->assertSame( $plain, Worker_Should_Stop::combine( [ $plain, new Worker_Should_Stop_Clean( 'clean-32' ) ] ) );
	}

	public function test_two_bare_plain_stops_combine_to_the_first(): void {
		$first = new Worker_Should_Stop( 'deadline-41' );

		$this->assertSame( $first, Worker_Should_Stop::combine( [ $first, new Worker_Should_Stop( 'deadline-42' ) ] ) );
	}

	public function test_a_clean_stop_beside_a_failure_is_a_plain_stop_carrying_it(): void {
		$poison = new \RuntimeException( 'poison-51' );

		$combined = Worker_Should_Stop::combine( [ new Worker_Should_Stop_Clean( 'clean-52' ), $poison ] );

		$this->assertInstanceOf( Worker_Should_Stop::class, $combined );
		$this->assertFalse( Worker_Should_Stop::is_clean( $combined ) );
		$this->assertNotInstanceOf( Worker_Should_Stop_Clean::class, $combined );
		$this->assertSame( $poison, $combined->getPrevious() );
		$this->assertSame( 'clean-52', $combined->getMessage() );
	}

	public function test_a_stop_beside_two_failures_carries_both(): void {
		$first  = new \RuntimeException( 'poison-61' );
		$second = new \LogicException( 'poison-62' );

		$combined = Worker_Should_Stop::combine( [ $first, new Worker_Should_Stop( 'deadline-63' ), $second ] );

		$this->assertInstanceOf( Worker_Should_Stop::class, $combined );
		$carried = $combined->getPrevious();
		$this->assertInstanceOf( Failures::class, $carried );
		$this->assertSame( [ $first, $second ], $carried->all() );
	}

	public function test_a_single_plain_stop_already_carrying_the_one_failure_is_returned_as_is(): void {
		$stop = new Worker_Should_Stop( 'deadline-71', 0, new \RuntimeException( 'flush-72' ) );

		$this->assertSame( $stop, Worker_Should_Stop::combine( [ $stop ] ) );
		$this->assertSame( $stop, Worker_Should_Stop::combine( [ new Worker_Should_Stop_Clean( 'clean-73' ), $stop ] ), 'the bare clean stop adds no failure' );
	}

	public function test_a_clean_stop_carrying_a_failure_combines_to_a_plain_stop_carrying_it(): void {
		$flush = new \RuntimeException( 'flush-81' );

		$combined = Worker_Should_Stop::combine( [ new Worker_Should_Stop_Clean( 'clean-82', 0, $flush ) ] );

		$this->assertInstanceOf( Worker_Should_Stop::class, $combined );
		$this->assertNotInstanceOf( Worker_Should_Stop_Clean::class, $combined );
		$this->assertSame( $flush, $combined->getPrevious() );
	}

	public function test_two_stops_each_carrying_a_failure_carry_both(): void {
		$flush_a = new \RuntimeException( 'flush-91' );
		$flush_b = new \RuntimeException( 'flush-92' );

		$combined = Worker_Should_Stop::combine(
			[
				new Worker_Should_Stop( 'deadline-93', 0, $flush_a ),
				new Worker_Should_Stop( 'deadline-94', 0, $flush_b ),
			]
		);

		$this->assertInstanceOf( Worker_Should_Stop::class, $combined );
		$this->assertInstanceOf( Failures::class, $combined->getPrevious() );
		$this->assertSame( [ $flush_a, $flush_b ], $combined->getPrevious()->all() );
	}

	public function test_a_lone_failure_propagates_as_itself(): void {
		$poison = new \DomainException( 'poison-101' );

		$this->assertSame( $poison, Worker_Should_Stop::combine( [ $poison ] ) );
	}

	public function test_several_failures_without_a_stop_propagate_together(): void {
		$first  = new \RuntimeException( 'poison-111' );
		$second = new \LogicException( 'poison-112' );

		$combined = Worker_Should_Stop::combine( [ $first, $second ] );

		$this->assertInstanceOf( Failures::class, $combined );
		$this->assertSame( [ $first, $second ], $combined->all() );
	}

	public function test_nested_failures_flatten_before_combining(): void {
		$a = new \RuntimeException( 'poison-121' );
		$b = new \RuntimeException( 'poison-122' );
		$c = new \RuntimeException( 'poison-123' );

		$combined = Worker_Should_Stop::combine( [ new Failures( [ $a, $b ] ), $c ] );

		$this->assertInstanceOf( Failures::class, $combined );
		$this->assertSame( [ $a, $b, $c ], $combined->all() );
	}

	public function test_nested_failures_beside_a_stop_flatten_into_its_previous(): void {
		$a = new \RuntimeException( 'poison-131' );
		$b = new \RuntimeException( 'poison-132' );

		$combined = Worker_Should_Stop::combine( [ new Failures( [ $a, $b ] ), new Worker_Should_Stop_Clean( 'clean-133' ) ] );

		$this->assertNotInstanceOf( Worker_Should_Stop_Clean::class, $combined );
		$this->assertSame( [ $a, $b ], $combined->getPrevious()->all() );
	}

	public function test_raise_throws_the_combination(): void {
		$poison = new \RuntimeException( 'poison-141' );

		try {
			Worker_Should_Stop::raise( [ new Worker_Should_Stop( 'deadline-142' ), $poison ] );
			$this->fail( 'expected a stop' );
		} catch ( Worker_Should_Stop $e ) {
			$this->assertSame( $poison, $e->getPrevious() );
		}
	}

	public function test_a_single_stop_already_carrying_several_failures_is_returned_as_is(): void {
		$stop = new Worker_Should_Stop( 'deadline-151', 0, new Failures( [ new \RuntimeException( 'flush-152' ), new \RuntimeException( 'flush-153' ) ] ) );

		$this->assertSame( $stop, Worker_Should_Stop::combine( [ $stop ] ) );
		$this->assertSame( $stop, Worker_Should_Stop::combine( [ $stop, new Worker_Should_Stop( 'deadline-154' ) ] ), 'a bare stop adds no failure' );
	}

	public function test_a_lone_failures_propagates_as_itself(): void {
		$failures = new Failures( [ new \RuntimeException( 'poison-157' ), new \RuntimeException( 'poison-158' ) ] );

		$this->assertSame( $failures, Worker_Should_Stop::combine( [ $failures ] ) );
	}

	public function test_one_failure_caught_twice_combines_to_itself(): void {
		$memoized = new \RuntimeException( 'unreadable-171' );

		$this->assertSame( $memoized, Worker_Should_Stop::combine( [ 'wake-map' => $memoized, 'spawn-gate' => $memoized ] ) );
	}

	public function test_two_failures_that_read_alike_stay_two(): void {
		$alpha = new \RuntimeException( 'usage: cmd-179' );
		$beta  = new \RuntimeException( 'usage: cmd-179' );

		$combined = Worker_Should_Stop::combine( [ $alpha, $beta ] );

		$this->assertInstanceOf( Failures::class, $combined );
		$this->assertSame( [ $alpha, $beta ], $combined->all() );
	}

	public function test_a_failure_caught_beside_failures_already_holding_it_is_listed_once(): void {
		$a = new \RuntimeException( 'unreadable-172' );
		$b = new \RuntimeException( 'unreadable-173' );

		$combined = Worker_Should_Stop::combine( [ new Failures( [ $a, $b ] ), $a, $b ] );

		$this->assertInstanceOf( Failures::class, $combined );
		$this->assertSame( [ $a, $b ], $combined->all() );
		$this->assertStringStartsWith( '2 failures: ', $combined->getMessage() );
	}

	public function test_a_stop_beside_a_failure_it_already_carries_is_returned_as_is(): void {
		$flush = new \RuntimeException( 'flush-174' );
		$stop  = new Worker_Should_Stop( 'deadline-175', 0, $flush );

		$this->assertSame( $stop, Worker_Should_Stop::combine( [ $stop, $flush ] ) );
		$this->assertSame( $stop, Worker_Should_Stop::combine( [ $flush, $stop, $stop ] ) );
	}

	public function test_combine_and_raise_take_keyed_arrays(): void {
		$first  = new \RuntimeException( 'poison-161' );
		$second = new \LogicException( 'poison-162' );
		$clean  = new Worker_Should_Stop_Clean( 'clean-163' );

		$this->assertSame( $first, Worker_Should_Stop::combine( [ 'spoke-7' => $first ] ) );
		$this->assertSame( $clean, Worker_Should_Stop::combine( [ 'spoke-8' => $clean ] ) );
		$combined = Worker_Should_Stop::combine( [ 'spoke-7' => $first, 'spoke-9' => $second ] );
		$this->assertInstanceOf( Failures::class, $combined );
		$this->assertSame( [ $first, $second ], $combined->all() );
		try {
			Worker_Should_Stop::raise( [ 'spoke-7' => $first ] );
			$this->fail( 'expected the failure' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( $first, $e );
		}
	}

	public function test_only_a_plain_stop_carrying_nothing_is_bare(): void {
		$this->assertTrue( Worker_Should_Stop::is_bare( new Worker_Should_Stop( 'deadline-171' ) ) );
		$this->assertFalse( Worker_Should_Stop::is_bare( new Worker_Should_Stop( 'deadline-172', 0, new \RuntimeException( 'flush-173' ) ) ), 'a stop carrying a failure is not bare' );
		$this->assertFalse( Worker_Should_Stop::is_bare( new Worker_Should_Stop_Clean( 'clean-174' ) ), 'a clean stop is not bare' );
		$this->assertFalse( Worker_Should_Stop::is_bare( new \RuntimeException( 'poison-175' ) ) );
	}

	public function test_attempt_until_stop_returns_at_the_first_stop_with_everything_so_far(): void {
		$seen   = [];
		$poison = new \RuntimeException( 'poison-181' );
		$stop   = new Worker_Should_Stop( 'deadline-182' );
		$caught = Worker_Should_Stop::attempt_until_stop(
			[ 'row-1' => 'alpha', 'row-2' => 'poison', 'row-3' => 'stop', 'row-4' => 'omega' ],
			static function ( string $value, string $key ) use ( &$seen, $poison, $stop ): void {
				$seen[] = "{$key}={$value}";
				if ( 'poison' === $value ) {
					throw $poison;
				}
				if ( 'stop' === $value ) {
					throw $stop;
				}
			}
		);

		$this->assertSame( [ 'row-1=alpha', 'row-2=poison', 'row-3=stop' ], $seen, 'a failure runs on; the stop ends the loop' );
		$this->assertSame( [ 'row-2' => $poison, 'row-3' => $stop ], $caught );
	}

	public function test_attempt_until_stop_offers_every_item_when_nothing_stops(): void {
		$seen   = [];
		$poison = new \RuntimeException( 'poison-191' );
		$caught = Worker_Should_Stop::attempt_until_stop(
			[ 3 => 'gamma', 5 => 'poison', 8 => 'eta' ],
			static function ( string $value ) use ( &$seen, $poison ): void {
				$seen[] = $value;
				if ( 'poison' === $value ) {
					throw $poison;
				}
			}
		);

		$this->assertSame( [ 'gamma', 'poison', 'eta' ], $seen );
		$this->assertSame( [ 5 => $poison ], $caught );
	}

	public function test_raise_is_silent_when_nothing_was_caught(): void {
		Worker_Should_Stop::raise( [] );
		$this->addToAssertionCount( 1 );
	}

	public function test_attempt_each_offers_every_item_and_returns_everything_caught(): void {
		$seen   = [];
		$poison = new \RuntimeException( 'poison-151' );
		$stop   = new Worker_Should_Stop( 'deadline-152' );
		$caught = Worker_Should_Stop::attempt_each(
			[ 'a' => 'alpha', 'b' => 'poison', 'c' => 'stop', 'd' => 'omega' ],
			static function ( string $value, string $key ) use ( &$seen, $poison, $stop ): void {
				$seen[] = "{$key}={$value}";
				if ( 'poison' === $value ) {
					throw $poison;
				}
				if ( 'stop' === $value ) {
					throw $stop;
				}
			}
		);

		$this->assertSame( [ 'a=alpha', 'b=poison', 'c=stop', 'd=omega' ], $seen, 'every item is offered, the throws notwithstanding' );
		$this->assertSame( [ 'b' => $poison, 'c' => $stop ], $caught, 'each failure keeps its item\'s key' );
	}

	public function test_attempt_each_returns_nothing_when_nothing_throws(): void {
		$this->assertSame( [], Worker_Should_Stop::attempt_each( [ 1, 2, 3 ], static fn () => null ) );
	}

	public function test_attempt_runs_every_step_in_order_and_returns_everything_caught(): void {
		$ran    = [];
		$poison = new \RuntimeException( 'poison-161' );
		$stop   = new Worker_Should_Stop_Clean( 'clean-162' );

		$caught = Worker_Should_Stop::attempt(
			static function () use ( &$ran ): void {
				$ran[] = 'first-163';
			},
			static function () use ( &$ran, $poison ): void {
				$ran[] = 'poison-164';
				throw $poison;
			},
			static function () use ( &$ran, $stop ): void {
				$ran[] = 'stop-165';
				throw $stop;
			},
			static function () use ( &$ran ): void {
				$ran[] = 'last-166';
			}
		);

		$this->assertSame( [ 'first-163', 'poison-164', 'stop-165', 'last-166' ], $ran, 'every step runs, the throws notwithstanding' );
		$this->assertSame( [ $poison, $stop ], $caught );
	}

	public function test_attempt_takes_named_steps_spread_from_a_keyed_array(): void {
		$ran   = [];
		$steps = [
			'spawn-171'  => static function () use ( &$ran ): void {
				$ran[] = 'spawn-171';
			},
			'alerts-172' => static function () use ( &$ran ): void {
				$ran[] = 'alerts-172';
			},
		];

		$this->assertSame( [], Worker_Should_Stop::attempt( ...$steps ) );
		$this->assertSame( [ 'spawn-171', 'alerts-172' ], $ran );
	}

	public function test_attempt_with_no_steps_catches_nothing(): void {
		$this->assertSame( [], Worker_Should_Stop::attempt() );
	}
}
