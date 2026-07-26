<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tee_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Worker_Should_Stop_Clean;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Which throwable escapes a fan-out when several targets fail at once.
 *
 * Tee defers the first throwable and re-throws after attempting every target
 * (ADR-14's fan-out carve-out). When the failures differ in kind the deferred
 * slot has to hold the one whose handling is SAFEST, because that decision moves
 * the consumer cursor:
 *
 *   plain Worker_Should_Stop  → replay the message (cursor stays put)
 *   Worker_Should_Stop_Clean  → commit PAST it (cursor advances)
 *   anything else             → poison, dead-letter, cursor advances
 *
 * Advancing past a message that needed a replay loses it. Replaying one that was
 * already clean is a duplicate, which at-least-once already tolerates. So a plain
 * stop outranks both of the others, and ADR-14 says as much: "a stop must re-play,
 * not advance."
 *
 * THIS IS AN EXPERIMENT, and it REVERSES a deliberate earlier decision. The
 * previous rule was "Clean always wins, in either order" — Chris set it that way
 * because request-builder was producing duplicates and a sibling branch was
 * suspected of interfering with its clean stop. Preferring Clean suppressed the
 * symptom; whether it addressed the cause was never established.
 *
 * The revert signal is therefore specific: **duplicate deliveries in
 * request-builder**. The mechanism to look for is a fan-out where the
 * clean-stopping snapshot node has a SIBLING that raises a plain
 * Worker_Should_Stop in the same pass — a deadline hit mid-fan-out will do it.
 * Under the old rule the Clean survived and the cursor advanced; under this one
 * the plain stop wins and the message replays, which is the duplicate.
 *
 * If that happens, the sibling's plain stop is the thing to explain, not this
 * rule — but restoring `! ( $deferred instanceof Worker_Should_Stop_Clean )` in
 * Tee_Node::fill() and deleting the two Clean-losing cases below puts it back.
 */
#[CoversClass( Tee_Node::class )]
class TeeStopPrecedenceTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		( new Router_Node() )->name( '_router' );
		// Rate-limited error trail would otherwise pollute the run.
		Core::set_stderr_handler( static fn ( $message ) => null );
	}

	/** A named node that throws $e when filled. */
	private function thrower( string $name, \Throwable $e ): void {
		$node = new class() extends \Newspack_Nodes\Node {
			public \Throwable $boom;

			public function fill( array $message ): void {
				throw $this->boom;
			}
		};
		$node->boom = $e;
		$node->name( $name );
	}

	/** Fan out to $targets in order and return whatever escapes. */
	private function escaping( string ...$targets ): ?\Throwable {
		$tee = new Tee_Node();
		$tee->name( 'tee' );
		$tee->sink( Core::node( '_router' ) );
		foreach ( $targets as $t ) {
			$tee->connect_node( $t );
		}

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'data';

		try {
			$tee->fill( $message );
		} catch ( \Throwable $e ) {
			return $e;
		}
		return null;
	}

	/** Already true: the poison would advance the cursor, the stop must not let it. */
	public function test_a_cooperative_stop_outranks_a_deferred_poison(): void {
		$this->thrower( 'poison', new \RuntimeException( 'poison' ) );
		$this->thrower( 'stopping', new Worker_Should_Stop( 'deadline' ) );

		$escaped = $this->escaping( 'poison', 'stopping' );

		$this->assertInstanceOf( Worker_Should_Stop::class, $escaped );
		$this->assertSame( 'deadline', $escaped->getMessage() );
	}

	/**
	 * The change. A deferred Clean used to be sticky, so a co-occurring plain stop
	 * could not displace it and the cursor advanced past a message that needed a
	 * replay.
	 */
	public function test_a_plain_stop_outranks_a_deferred_clean_stop(): void {
		$this->thrower( 'clean', new Worker_Should_Stop_Clean( 'clean recycle' ) );
		$this->thrower( 'stopping', new Worker_Should_Stop( 'deadline' ) );

		$escaped = $this->escaping( 'clean', 'stopping' );

		$this->assertNotInstanceOf( Worker_Should_Stop_Clean::class, $escaped, 'a clean stop must not survive a plain one' );
		$this->assertInstanceOf( Worker_Should_Stop::class, $escaped );
		$this->assertSame( 'deadline', $escaped->getMessage() );
	}

	/** And not the other way round: a later Clean must not downgrade a deferred plain stop. */
	public function test_a_clean_stop_does_not_displace_a_deferred_plain_stop(): void {
		$this->thrower( 'stopping', new Worker_Should_Stop( 'deadline' ) );
		$this->thrower( 'clean', new Worker_Should_Stop_Clean( 'clean recycle' ) );

		$escaped = $this->escaping( 'stopping', 'clean' );

		$this->assertNotInstanceOf( Worker_Should_Stop_Clean::class, $escaped );
		$this->assertSame( 'deadline', $escaped->getMessage() );
	}
}
