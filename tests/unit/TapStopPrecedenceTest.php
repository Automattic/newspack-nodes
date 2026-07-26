<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tap_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Worker_Should_Stop_Clean;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Tap shares Tee's failure handling and keeps one difference: it hard-addresses
 * each target, discarding the remainder, then passes the original through.
 *
 * What it must NOT do is throw the instant a target fails. The passthrough IS
 * the pipeline; skipping it drops the message from the main path, and a target
 * skipped by an early throw never receives the message at all once the poison
 * path dead-letters it and advances the cursor. Completing the fan-out is what
 * preserves at-least-once; duplicates on replay are its accepted cost, and they
 * arise with any fan-out regardless of when it throws.
 */
#[CoversClass( Tap_Node::class )]
class TapStopPrecedenceTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		( new Router_Node() )->name( '_router' );
		Core::set_stderr_handler( static fn ( $message ) => null );
	}

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

	/** @return array{passthrough:?array<int,mixed>,escaped:?\Throwable} */
	private function tap_through( string ...$targets ): array {
		$downstream = new Capture_Sink_Node();
		$downstream->name( 'downstream' );

		$tap = new Tap_Node();
		$tap->name( 'tap' );
		$tap->sink( Core::node( '_router' ) );
		foreach ( $targets as $t ) {
			$tap->connect_node( $t );
		}

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::TO ]    = 'downstream';
		$message[ Message::VALUE ] = 'data';

		$escaped = null;
		try {
			$tap->fill( $message );
		} catch ( \Throwable $e ) {
			$escaped = $e;
		}
		return [
			'passthrough' => $downstream->captured[0] ?? null,
			'escaped'     => $escaped,
		];
	}

	/**
	 * An ordinary tap error propagates like any other fan-out failure — but only
	 * after the passthrough, so the pipeline has the message before the consumer
	 * decides to replay or dead-letter it.
	 */
	public function test_an_ordinary_tap_error_propagates_after_the_passthrough(): void {
		$this->thrower( 'broken', new \RuntimeException( 'tap blew up' ) );

		$result = $this->tap_through( 'broken' );

		$this->assertNotNull( $result['passthrough'], 'the pipeline receives it first' );
		$this->assertInstanceOf( \RuntimeException::class, $result['escaped'] );
		$this->assertSame( 'tap blew up', $result['escaped']->getMessage() );
	}

	/**
	 * The change. A Clean stop from a tap used to abort before the passthrough,
	 * so the consumer committed PAST a message the pipeline never saw.
	 */
	public function test_a_clean_stop_from_a_tap_still_lets_the_message_through(): void {
		$this->thrower( 'snapshot', new Worker_Should_Stop_Clean( 'clean recycle' ) );

		$result = $this->tap_through( 'snapshot' );

		$this->assertNotNull( $result['passthrough'], 'commit-past must never skip the pipeline write' );
		$this->assertInstanceOf( Worker_Should_Stop_Clean::class, $result['escaped'], 'and the stop still propagates' );
	}

	public function test_a_plain_stop_from_a_tap_propagates_after_the_passthrough(): void {
		$this->thrower( 'stopping', new Worker_Should_Stop( 'deadline' ) );

		$result = $this->tap_through( 'stopping' );

		$this->assertNotNull( $result['passthrough'] );
		$this->assertInstanceOf( Worker_Should_Stop::class, $result['escaped'] );
		$this->assertSame( 'deadline', $result['escaped']->getMessage() );
	}

	/** Same precedence as Tee, from the one shared rule: replay beats advance-past. */
	public function test_a_plain_stop_outranks_a_clean_one_across_two_taps(): void {
		$this->thrower( 'snapshot', new Worker_Should_Stop_Clean( 'clean recycle' ) );
		$this->thrower( 'stopping', new Worker_Should_Stop( 'deadline' ) );

		$result = $this->tap_through( 'snapshot', 'stopping' );

		$this->assertNotNull( $result['passthrough'] );
		$this->assertNotInstanceOf( Worker_Should_Stop_Clean::class, $result['escaped'] );
		$this->assertSame( 'deadline', $result['escaped']->getMessage() );
	}

	/** Every tap is attempted even after one stops; a stop is not a reason to starve siblings. */
	public function test_a_stopping_tap_does_not_starve_its_siblings(): void {
		$this->thrower( 'stopping', new Worker_Should_Stop( 'deadline' ) );
		$sibling = new Capture_Sink_Node();
		$sibling->name( 'sibling' );

		$result = $this->tap_through( 'stopping', 'sibling' );

		$this->assertCount( 1, $sibling->captured, 'the sibling tap still fired' );
		$this->assertNotNull( $result['passthrough'] );
	}
}
