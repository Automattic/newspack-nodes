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

	public function test_combined_failures_report_the_first_failures_origin(): void {
		$first  = new \RuntimeException( 'origin-61' );
		$second = new \RuntimeException( 'other-62' );

		$combined = Worker_Should_Stop::combine( [ $first, $second ] );

		$this->assertSame( __FILE__, $combined->getFile() );
		$this->assertSame( $first->getLine(), $combined->getLine() );
	}

	public function test_a_fresh_stop_carrying_a_failure_reports_that_failures_origin(): void {
		$failure = new \RuntimeException( 'flush-71' );

		$combined = Worker_Should_Stop::combine( [ new Worker_Should_Stop_Clean( 'recycle-72' ), $failure ] );

		$this->assertInstanceOf( Worker_Should_Stop::class, $combined );
		$this->assertSame( $failure, $combined->getPrevious() );
		$this->assertSame( __FILE__, $combined->getFile() );
		$this->assertSame( $failure->getLine(), $combined->getLine() );
	}

	public function test_a_fresh_stop_carrying_several_failures_reports_the_first_ones_origin(): void {
		$first  = new \RuntimeException( 'first-81' );
		$second = new \RuntimeException( 'second-82' );

		$combined = Worker_Should_Stop::combine( [ new Worker_Should_Stop( 'deadline-83' ), $first, $second ] );

		$this->assertSame( $first->getLine(), $combined->getLine() );
	}

	public function test_failures_of_unwraps_stops_and_flattens_failures(): void {
		$first  = new \RuntimeException( 'tsl-110' );
		$second = new \RuntimeException( 'tsl-111' );
		$plain  = new \RuntimeException( 'disk-112' );

		$this->assertSame( [ $plain ], Worker_Should_Stop::failures_of( $plain ) );
		$this->assertSame( [ $first, $second ], Worker_Should_Stop::failures_of( new Failures( [ $first, $second ] ) ) );
		$this->assertSame(
			[ $first, $second ],
			Worker_Should_Stop::failures_of( new Worker_Should_Stop( 'outer-113', 0, new Worker_Should_Stop( 'inner-114', 0, new Failures( [ $first, $second ] ) ) ) ),
			'a stop whose previous is a stop is walked to the end'
		);
		$this->assertSame( [], Worker_Should_Stop::failures_of( new Worker_Should_Stop( 'bare-115' ) ) );
	}

	public function test_causes_of_is_the_failures_or_the_throwable_itself(): void {
		$bare  = new Worker_Should_Stop( 'bare-146' );
		$inner = new \RuntimeException( 'disk-147' );

		$this->assertSame( [ $bare ], Worker_Should_Stop::causes_of( $bare ) );
		$this->assertSame( [ $inner ], Worker_Should_Stop::causes_of( new Worker_Should_Stop( 'deadline-148', 0, $inner ) ) );
	}

	public function test_a_stop_carrying_a_stop_combines_to_what_the_inner_one_carries(): void {
		$deep = new \RuntimeException( 'deep-116' );

		$combined = Worker_Should_Stop::combine( [ new Worker_Should_Stop( 'outer-117', 0, new Worker_Should_Stop( 'inner-118', 0, $deep ) ) ] );

		$this->assertInstanceOf( Worker_Should_Stop::class, $combined );
		$this->assertSame( $deep, $combined->getPrevious() );
	}

	/**
	 * A chain of stops that ends in no failure still combines to a stop the
	 * reader replays — plain, never clean, and never bare — rather than to the
	 * `Failures` of nothing, which cannot be built.
	 */
	public function test_a_stop_carrying_a_bare_stop_combines_to_a_plain_carrying_stop(): void {
		$outer = new Worker_Should_Stop( 'outer-131', 0, new Worker_Should_Stop( 'inner-132' ) );

		$this->assertReplays( Worker_Should_Stop::combine( [ $outer ] ) );
	}

	public function test_a_clean_stop_carrying_a_bare_stop_combines_to_a_plain_carrying_stop(): void {
		$clean = new Worker_Should_Stop_Clean( 'recycle-133', 0, new Worker_Should_Stop( 'deadline-134' ) );

		$this->assertReplays( Worker_Should_Stop::combine( [ $clean ] ) );
	}

	public function test_that_clean_stop_beside_a_plain_stop_carrying_a_stop_combines_to_a_plain_carrying_stop(): void {
		$clean = new Worker_Should_Stop_Clean( 'recycle-135', 0, new Worker_Should_Stop( 'deadline-136' ) );
		$outer = new Worker_Should_Stop( 'outer-137', 0, new Worker_Should_Stop( 'inner-138' ) );

		$this->assertReplays( Worker_Should_Stop::combine( [ $clean, $outer ] ) );
	}

	/**
	 * A plain stop that carries something: no reader may commit past it.
	 *
	 * @param \Throwable|null $combined What `combine()` returned.
	 */
	private function assertReplays( ?\Throwable $combined ): void {
		$this->assertInstanceOf( Worker_Should_Stop::class, $combined );
		$this->assertFalse( Worker_Should_Stop::is_clean( $combined ), 'never clean' );
		$this->assertFalse( Worker_Should_Stop::is_bare( $combined ), 'never bare' );
	}

	public function test_report_writes_one_line_per_cause_under_its_key(): void {
		$lines   = $this->capture_stderr();
		$tsl     = new \RuntimeException( 'tsl-91' );
		$tsl2    = new \RuntimeException( 'tsl-92' );
		$disk    = new \RuntimeException( 'disk-95' );
		$bare    = new Worker_Should_Stop( 'deadline-99' );

		Worker_Should_Stop::report( 'sweep-93', [
			'plain-94' => $disk,
			'stop-96'  => new Worker_Should_Stop( 'deadline-97', 0, new Failures( [ $tsl, $tsl2 ] ) ),
			'bare-98'  => $bare,
		] );

		$this->assertSame(
			[
				'sweep-93: plain-94: ' . self::cause_text( $disk ),
				'sweep-93: stop-96: ' . self::cause_text( $tsl ),
				'sweep-93: stop-96: ' . self::cause_text( $tsl2 ),
				'sweep-93: bare-98: ' . self::cause_text( $bare ),
			],
			self::stderr_lines( $lines )
		);
	}

	public function test_report_walks_each_causes_previous_chain(): void {
		$lines = $this->capture_stderr();
		$root  = new \LogicException( 'root-120' );
		$mid   = new \RuntimeException( 'mid-121', 0, $root );
		$top   = new \RuntimeException( 'top-122', 0, $mid );

		Worker_Should_Stop::report( 'sweep-123', [ 'step-124' => $top ] );

		$this->assertSame(
			[ 'sweep-123: step-124: ' . self::cause_text( $top ) . '; previous: ' . self::cause_text( $mid ) . '; previous: ' . self::cause_text( $root ) ],
			self::stderr_lines( $lines )
		);
	}

	public function test_report_with_no_label_writes_the_key_first(): void {
		$lines = $this->capture_stderr();
		$disk  = new \RuntimeException( 'disk-102' );

		Worker_Should_Stop::report( '', [ 'step-101' => $disk ] );

		$this->assertSame( [ 'step-101: ' . self::cause_text( $disk ) ], self::stderr_lines( $lines ) );
	}

	/**
	 * A boundary's report must not itself escape: a `newspack_nodes/stderr`
	 * listener that throws costs no line, and its failure goes to error_log().
	 */
	public function test_report_survives_a_throwing_stderr_listener(): void {
		$lines     = $this->capture_stderr();
		$error_log = $this->make_temp_dir( 'report-error-log-' ) . '/php-error.log';
		$saved     = \ini_set( 'error_log', $error_log );
		\add_action( 'newspack_nodes/stderr', static function (): void {
			throw new \RuntimeException( 'listener refused-127' );
		} );

		try {
			Worker_Should_Stop::report( 'sweep-125', [
				'one-126' => new \RuntimeException( 'disk-128' ),
				'two-129' => new \RuntimeException( 'disk-130' ),
			] );
		} finally {
			\ini_set( 'error_log', (string) $saved );
		}

		$this->assertCount( 2, self::stderr_lines( $lines, 'sweep-125: ' ), 'every line still printed' );
		$this->assertStringContainsString( 'listener refused-127', (string) \file_get_contents( $error_log ) );
	}

	/**
	 * A stderr handler that throws must not lose the cause either: the line
	 * goes to error_log() beside the handler's own failure.
	 */
	public function test_report_survives_a_throwing_stderr_handler_and_keeps_the_line(): void {
		$error_log = $this->make_temp_dir( 'report-handler-log-' ) . '/php-error.log';
		$saved     = \ini_set( 'error_log', $error_log );
		\Newspack_Nodes\Core::set_stderr_handler( static function (): void {
			throw new \RuntimeException( 'handler refused-140' );
		} );

		try {
			Worker_Should_Stop::report( 'sweep-141', [
				'one-142' => new \RuntimeException( 'disk-143' ),
				'two-144' => new \RuntimeException( 'disk-145' ),
			] );
		} finally {
			\ini_set( 'error_log', (string) $saved );
		}

		$logged = (string) \file_get_contents( $error_log );
		$this->assertStringContainsString( 'sweep-141: one-142: disk-143', $logged );
		$this->assertStringContainsString( 'sweep-141: two-144: disk-145', $logged, 'the next line is still attempted' );
		$this->assertStringContainsString( 'handler refused-140', $logged );
	}

	public function test_report_writes_nothing_for_nothing_caught(): void {
		$lines = $this->capture_stderr();

		Worker_Should_Stop::report( 'sweep-100', [] );

		$this->assertCount( 0, $lines );
	}
}
