<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Failures;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tee_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Worker_Should_Stop_Clean;

/**
 * What escapes a fan-out when several targets fail at once.
 *
 * Tee attempts every target and raises afterwards what every one threw,
 * combined (ADR-14). The result moves the consumer cursor, so the rule is
 * about which outcome the reader acts on:
 *
 *   every target a bare clean stop  → clean, commit PAST the message
 *   any stop among them             → a plain stop carrying every failure, replay
 *   failures alone                  → every failure propagates, dead-letter
 *
 * Nothing a target threw is dropped for arriving beside something else.
 */
#[CoversClass( Tee_Node::class )]
class TeeStopPrecedenceTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		( new Router_Node() )->name( '_router' );
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

	public function test_a_stop_beside_a_poison_is_a_stop_carrying_the_poison(): void {
		$poison = new \RuntimeException( 'poison-11' );
		$this->thrower( 'poison', $poison );
		$this->thrower( 'stopping', new Worker_Should_Stop( 'deadline-12' ) );

		$escaped = $this->escaping( 'poison', 'stopping' );

		$this->assertInstanceOf( Worker_Should_Stop::class, $escaped );
		$this->assertSame( $poison, $escaped->getPrevious(), 'the poison escapes with the stop' );
	}

	public function test_a_plain_stop_after_a_clean_one_is_plain(): void {
		$this->thrower( 'clean', new Worker_Should_Stop_Clean( 'clean-21' ) );
		$this->thrower( 'stopping', new Worker_Should_Stop( 'deadline-22' ) );

		$escaped = $this->escaping( 'clean', 'stopping' );

		$this->assertFalse( Worker_Should_Stop::is_clean( $escaped ), 'a clean stop must not survive a plain one' );
		$this->assertSame( 'deadline-22', $escaped->getMessage() );
	}

	public function test_a_clean_stop_after_a_plain_one_is_plain(): void {
		$this->thrower( 'stopping', new Worker_Should_Stop( 'deadline-23' ) );
		$this->thrower( 'clean', new Worker_Should_Stop_Clean( 'clean-24' ) );

		$escaped = $this->escaping( 'stopping', 'clean' );

		$this->assertFalse( Worker_Should_Stop::is_clean( $escaped ) );
		$this->assertSame( 'deadline-23', $escaped->getMessage() );
	}

	public function test_a_clean_stop_beside_a_poison_is_not_clean(): void {
		$poison = new \RuntimeException( 'poison-31' );
		$this->thrower( 'clean', new Worker_Should_Stop_Clean( 'clean-32' ) );
		$this->thrower( 'poison', $poison );

		$escaped = $this->escaping( 'clean', 'poison' );

		$this->assertInstanceOf( Worker_Should_Stop::class, $escaped );
		$this->assertFalse( Worker_Should_Stop::is_clean( $escaped ) );
		$this->assertSame( $poison, $escaped->getPrevious() );
	}

	public function test_every_target_a_clean_stop_is_clean(): void {
		$this->thrower( 'clean-a', new Worker_Should_Stop_Clean( 'clean-41' ) );
		$this->thrower( 'clean-b', new Worker_Should_Stop_Clean( 'clean-42' ) );

		$this->assertTrue( Worker_Should_Stop::is_clean( $this->escaping( 'clean-a', 'clean-b' ) ) );
	}

	public function test_two_poisons_both_escape_and_the_rest_still_receive(): void {
		$first  = new \RuntimeException( 'poison-51' );
		$second = new \RuntimeException( 'poison-52' );
		$this->thrower( 'poison-a', $first );
		$this->thrower( 'poison-b', $second );
		$healthy = new Capture_Sink_Node();
		$healthy->name( 'healthy' );

		$escaped = $this->escaping( 'poison-a', 'healthy', 'poison-b' );

		$this->assertCount( 1, $healthy->captured );
		$this->assertInstanceOf( Failures::class, $escaped );
		$this->assertSame( [ $first, $second ], $escaped->all() );
	}
}
