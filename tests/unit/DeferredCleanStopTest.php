<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversTrait;
use Newspack_Nodes\Deferred_Clean_Stop;
use Newspack_Nodes\Failures;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Worker_Should_Stop_Clean;

/**
 * Contract test for the write-side clean-stop trait. It's consumed by application
 * snapshot nodes in sibling plugins, so it's exercised here at its definition via a
 * minimal probe rather than a real substrate node.
 */
#[CoversTrait( Deferred_Clean_Stop::class )]
class DeferredCleanStopTest extends TestCase {

	private function probe(): object {
		return new class {
			use Deferred_Clean_Stop;

			/** @var list<string> What the bracket body reached, in order. */
			public array $reached = [];

			public function bracket( \Closure $body ): void {
				$this->deferring( $body );
			}

			public function forward( \Closure $forward ): void {
				$this->guarded( $forward );
			}
		};
	}

	/** Run $body inside the probe's bracket and return what escapes. */
	private function escaping( object $p, \Closure $body ): ?\Throwable {
		try {
			$p->bracket( $body );
		} catch ( \Throwable $e ) {
			return $e;
		}
		return null;
	}

	public function test_a_deferred_bare_stop_lets_the_body_finish_then_raises_clean(): void {
		$p = $this->probe();

		$escaped = $this->escaping(
			$p,
			function () use ( $p ): void {
				$p->forward( static function (): void {
					throw new Worker_Should_Stop( 'deadline-11' );
				} );
				$p->reached[] = 'bookkeeping-12';
			}
		);

		$this->assertSame( [ 'bookkeeping-12' ], $p->reached, 'the stop waited for the bookkeeping' );
		$this->assertInstanceOf( Worker_Should_Stop_Clean::class, $escaped );
		$this->assertTrue( Worker_Should_Stop::is_clean( $escaped ) );
	}

	public function test_a_deferred_stop_carrying_a_flush_failure_raises_plain_with_it(): void {
		$p     = $this->probe();
		$flush = new \RuntimeException( 'segment write refused: ENOSPC-21' );

		$escaped = $this->escaping(
			$p,
			fn () => $p->forward( static function () use ( $flush ): void {
				throw new Worker_Should_Stop( 'deadline-22', 0, $flush );
			} )
		);

		$this->assertInstanceOf( Worker_Should_Stop::class, $escaped );
		$this->assertFalse( Worker_Should_Stop::is_clean( $escaped ) );
		$this->assertSame( $flush, $escaped->getPrevious() );
	}

	public function test_a_bare_stop_beside_a_stop_carrying_a_flush_failure_raises_the_failure(): void {
		$p     = $this->probe();
		$flush = new \RuntimeException( 'segment write refused: ENOSPC-31' );

		$escaped = $this->escaping(
			$p,
			function () use ( $p, $flush ): void {
				$p->forward( static function (): void {
					throw new Worker_Should_Stop( 'deadline-32' );
				} );
				$p->forward( static function () use ( $flush ): void {
					throw new Worker_Should_Stop( 'deadline-33', 0, $flush );
				} );
			}
		);

		$this->assertFalse( Worker_Should_Stop::is_clean( $escaped ) );
		$this->assertSame( $flush, $escaped->getPrevious(), 'the failure is never dropped for arriving second' );
	}

	public function test_a_deferred_clean_stop_carrying_a_failure_is_not_clean(): void {
		$p     = $this->probe();
		$flush = new \RuntimeException( 'segment write refused: ENOSPC-41' );

		$escaped = $this->escaping(
			$p,
			fn () => $p->forward( static function () use ( $flush ): void {
				throw new Worker_Should_Stop_Clean( 'clean-42', 0, $flush );
			} )
		);

		$this->assertNotInstanceOf( Worker_Should_Stop_Clean::class, $escaped );
		$this->assertSame( $flush, $escaped->getPrevious() );
	}

	public function test_a_failure_after_a_deferred_stop_escapes_on_a_plain_stop(): void {
		$p      = $this->probe();
		$poison = new \RuntimeException( 'bookkeeping blew up-51' );

		$escaped = $this->escaping(
			$p,
			function () use ( $p, $poison ): void {
				$p->forward( static function (): void {
					throw new Worker_Should_Stop( 'deadline-52' );
				} );
				throw $poison;
			}
		);

		$this->assertInstanceOf( Worker_Should_Stop::class, $escaped );
		$this->assertFalse( Worker_Should_Stop::is_clean( $escaped ), 'the message never finished, so it replays' );
		$this->assertSame( $poison, $escaped->getPrevious() );
	}

	public function test_guarded_lets_a_non_stop_throwable_propagate_at_once(): void {
		$p      = $this->probe();
		$poison = new \RuntimeException( 'poison-61' );

		$escaped = $this->escaping(
			$p,
			function () use ( $p, $poison ): void {
				$p->forward( static function () use ( $poison ): void {
					throw $poison;
				} );
				$p->reached[] = 'after-62';
			}
		);

		$this->assertSame( [], $p->reached );
		$this->assertSame( $poison, $escaped );
	}

	public function test_two_failures_in_one_bracket_both_escape(): void {
		$p      = $this->probe();
		$first  = new \RuntimeException( 'flush-71' );
		$second = new \RuntimeException( 'poison-72' );

		$escaped = $this->escaping(
			$p,
			function () use ( $p, $first, $second ): void {
				$p->forward( static function () use ( $first ): void {
					throw new Worker_Should_Stop( 'deadline-73', 0, $first );
				} );
				throw $second;
			}
		);

		$this->assertInstanceOf( Failures::class, $escaped->getPrevious() );
		$this->assertSame( [ $first, $second ], $escaped->getPrevious()->all() );
	}

	public function test_a_bracket_with_no_stop_raises_nothing(): void {
		$p = $this->probe();

		$escaped = $this->escaping(
			$p,
			function () use ( $p ): void {
				$p->forward( static fn () => null );
				$p->reached[] = 'done-81';
			}
		);

		$this->assertNull( $escaped );
		$this->assertSame( [ 'done-81' ], $p->reached );
	}

	public function test_outside_a_bracket_guarded_lets_a_stop_propagate_at_once(): void {
		$p    = $this->probe();
		$stop = new Worker_Should_Stop( 'deadline-91' );

		try {
			$p->forward( static function () use ( $stop ): void {
				throw $stop;
			} );
			$this->fail( 'a stop outside a bracket has nowhere to wait' );
		} catch ( Worker_Should_Stop $e ) {
			$this->assertSame( $stop, $e );
		}
	}

	public function test_a_closed_bracket_defers_nothing_into_the_next_message(): void {
		$p = $this->probe();
		$this->escaping(
			$p,
			fn () => $p->forward( static function (): void {
				throw new Worker_Should_Stop( 'deadline-101' );
			} )
		);

		$this->assertNull( $this->escaping( $p, static fn () => null ), 'a stop deferred for one message never raises at another' );
	}

	public function test_a_nested_bracket_keeps_its_stops_apart_from_the_outer_one(): void {
		$p = $this->probe();

		$escaped = $this->escaping(
			$p,
			function () use ( $p ): void {
				$p->forward( static function (): void {
					throw new Worker_Should_Stop( 'outer-111' );
				} );
				$p->bracket( static fn () => null );
				$p->reached[] = 'outer-continues-112';
			}
		);

		$this->assertSame( [ 'outer-continues-112' ], $p->reached, 'the inner bracket raised nothing of the outer one' );
		$this->assertTrue( Worker_Should_Stop::is_clean( $escaped ), 'and the outer stop survived the inner bracket' );
	}

	public function test_a_nested_brackets_stop_escapes_through_the_outer_one(): void {
		$p = $this->probe();

		$escaped = $this->escaping(
			$p,
			fn () => $p->bracket(
				fn () => $p->forward( static function (): void {
					throw new Worker_Should_Stop( 'inner-121' );
				} )
			)
		);

		$this->assertTrue( Worker_Should_Stop::is_clean( $escaped ) );
	}
}
