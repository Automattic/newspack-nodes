<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Worker_Should_Stop_Clean;
use Newspack_Nodes\Tests\TestCase;

/**
 * The fan-out rule every attempt-all loop shares (ADR-14): which throwable
 * escapes after the loop, and that every item is offered before it does.
 */
#[CoversClass( Worker_Should_Stop::class )]
class WorkerShouldStopTest extends TestCase {

	public function test_the_first_failure_takes_an_empty_slot(): void {
		$this->assertTrue( Worker_Should_Stop::outranks( new \RuntimeException( 'poison' ), null ) );
	}

	public function test_a_plain_stop_displaces_a_clean_stop_and_a_poison_in_either_order(): void {
		$plain = new Worker_Should_Stop();
		$this->assertTrue( Worker_Should_Stop::outranks( $plain, new Worker_Should_Stop_Clean() ) );
		$this->assertTrue( Worker_Should_Stop::outranks( $plain, new \RuntimeException( 'poison' ) ) );
		$this->assertFalse( Worker_Should_Stop::outranks( new Worker_Should_Stop_Clean(), $plain ) );
		$this->assertFalse( Worker_Should_Stop::outranks( new \RuntimeException( 'poison' ), $plain ) );
	}

	public function test_a_clean_stop_displaces_a_poison_and_a_poison_never_displaces(): void {
		$this->assertTrue( Worker_Should_Stop::outranks( new Worker_Should_Stop_Clean(), new \RuntimeException( 'poison' ) ) );
		$this->assertFalse( Worker_Should_Stop::outranks( new \RuntimeException( 'later' ), new \RuntimeException( 'first' ) ) );
		// A clean stop over a clean stop replaces it: same outcome either way.
		$this->assertTrue( Worker_Should_Stop::outranks( new Worker_Should_Stop_Clean(), new Worker_Should_Stop_Clean() ) );
	}

	public function test_attempt_each_offers_every_item_and_returns_the_ranked_failure(): void {
		$seen     = [];
		$deferred = Worker_Should_Stop::attempt_each(
			[ 'a' => 'alpha', 'b' => 'poison', 'c' => 'stop', 'd' => 'omega' ],
			static function ( string $value, string $key ) use ( &$seen ): void {
				$seen[] = "{$key}={$value}";
				if ( 'poison' === $value ) {
					throw new \RuntimeException( 'poison' );
				}
				if ( 'stop' === $value ) {
					throw new Worker_Should_Stop( 'stop' );
				}
			}
		);

		$this->assertSame( [ 'a=alpha', 'b=poison', 'c=stop', 'd=omega' ], $seen, 'every item is offered, the throws notwithstanding' );
		$this->assertInstanceOf( Worker_Should_Stop::class, $deferred );
		$this->assertSame( 'stop', $deferred->getMessage() );
	}

	public function test_attempt_each_returns_null_when_nothing_throws(): void {
		$this->assertNull( Worker_Should_Stop::attempt_each( [ 1, 2, 3 ], static fn () => null ) );
	}
}
