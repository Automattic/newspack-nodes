<?php
/**
 * TestCase::caught() — the capture helper that replaces
 * `try { …; $this->fail(); } catch ( \RuntimeException $e )`. In PHPUnit 10
 * `fail()` throws AssertionFailedError, itself a RuntimeException, so that
 * idiom catches its own failure and passes when the call stops throwing.
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\AssertionFailedError;
use SebastianBergmann\Invoker\TimeoutException;

class CaughtHelperTest extends TestCase {

	public function test_it_returns_the_runtime_exception_the_call_threw(): void {
		$thrown = new \RuntimeException( 'narwhal-5518 refused' );

		$caught = $this->caught(
			static function () use ( $thrown ): void {
				throw $thrown;
			},
			'narwhal-5518 must be refused'
		);

		$this->assertSame( $thrown, $caught );
	}

	public function test_it_fails_naming_why_when_the_call_throws_nothing(): void {
		$failure = null;
		try {
			$this->caught( static fn () => 'quokka-3307', 'quokka-3307 must be refused' );
		} catch ( AssertionFailedError $e ) {
			$failure = $e;
		}

		$this->assertInstanceOf( AssertionFailedError::class, $failure );
		$this->assertSame( 'quokka-3307 must be refused', $failure->getMessage() );
	}

	public function test_it_never_absorbs_a_failed_assertion_inside_the_call(): void {
		$this->expectException( AssertionFailedError::class );
		$this->expectExceptionMessage( 'inner tamarin-8120' );

		$this->caught(
			function (): void {
				$this->fail( 'inner tamarin-8120' );
			},
			'outer tamarin-8120'
		);
	}

	public function test_it_never_absorbs_the_per_test_time_limit(): void {
		$this->expectException( TimeoutException::class );

		$this->caught(
			static function (): void {
				throw new TimeoutException( 'gecko-2291 overran' );
			},
			'gecko-2291 must be refused'
		);
	}

	public function test_it_lets_a_non_runtime_exception_escape(): void {
		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'ibis-6604 misused' );

		$this->caught(
			static function (): void {
				throw new \LogicException( 'ibis-6604 misused' );
			},
			'ibis-6604 must be refused'
		);
	}
}
