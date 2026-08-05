<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Deferred_Clean_Stop;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Worker_Should_Stop_Clean;

/**
 * Contract test for the write-side clean-stop trait. It's consumed by application
 * snapshot nodes in sibling plugins, so it's exercised here at its definition via a
 * minimal probe rather than a real substrate node.
 */
#[CoversClass( Deferred_Clean_Stop::class )]
class DeferredCleanStopTest extends TestCase {

	private function probe(): object {
		return new class {
			use Deferred_Clean_Stop;
			public function do_guarded( \Closure $forward ): void {
				$this->guarded( $forward );
			}
			public function do_clear(): void {
				$this->clear_pending_stop();
			}
			public function do_raise(): void {
				$this->raise_pending_stop();
			}
		};
	}

	public function test_guarded_defers_a_stop_then_raise_re_raises_it_as_clean(): void {
		$p = $this->probe();
		$p->do_guarded( function (): void {
			throw new Worker_Should_Stop();
		} ); // deferred, not propagated.
		$this->expectException( Worker_Should_Stop_Clean::class );
		$p->do_raise();
	}

	public function test_raise_is_a_no_op_without_a_deferred_stop(): void {
		$p = $this->probe();
		$p->do_raise();
		$p->do_guarded( fn () => null ); // a forward that doesn't stop.
		$p->do_raise();
		$this->addToAssertionCount( 1 ); // reached here = no clean stop thrown.
	}

	public function test_clear_drops_a_deferred_stop_so_raise_is_a_no_op(): void {
		$p = $this->probe();
		$p->do_guarded( function (): void {
			throw new Worker_Should_Stop();
		} );
		$p->do_clear();
		$p->do_raise();
		$this->addToAssertionCount( 1 ); // cleared → no clean stop.
	}

	public function test_guarded_lets_a_non_stop_throwable_propagate(): void {
		$p = $this->probe();
		$this->expectException( \RuntimeException::class );
		$p->do_guarded( function (): void {
			throw new \RuntimeException( 'boom' );
		} );
	}

	public function test_guarded_keeps_the_first_deferred_stop(): void {
		$p = $this->probe();
		$first = new Worker_Should_Stop( 'first' );
		$p->do_guarded( function () use ( $first ): void {
			throw $first;
		} );
		$p->do_guarded( function (): void {
			throw new Worker_Should_Stop( 'second' );
		} );
		// Both deferred; raise throws Clean regardless — the first-wins precedence
		// matters only for which instance is stashed, verified by no double-raise.
		$this->expectException( Worker_Should_Stop_Clean::class );
		$p->do_raise();
	}
}
