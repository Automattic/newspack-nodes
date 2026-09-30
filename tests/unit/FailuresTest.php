<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Failures;
use Newspack_Nodes\Tests\TestCase;

/**
 * Several failures travelling as one throwable: every one kept, in order,
 * with none nested inside another.
 */
#[CoversClass( Failures::class )]
class FailuresTest extends TestCase {

	public function test_it_keeps_every_failure_in_order_and_names_each_in_its_message(): void {
		$first  = new \RuntimeException( 'disk-full-7' );
		$second = new \LogicException( 'bad-token-8' );

		$failures = new Failures( [ $first, $second ] );

		$this->assertSame( [ $first, $second ], $failures->all() );
		$this->assertSame( '2 failures: disk-full-7 | bad-token-8', $failures->getMessage() );
		$this->assertSame( $first, $failures->getPrevious() );
		$this->assertInstanceOf( \RuntimeException::class, $failures );
	}

	public function test_a_nested_failures_flattens_on_construction(): void {
		$a = new \RuntimeException( 'a-21' );
		$b = new \RuntimeException( 'b-22' );
		$c = new \RuntimeException( 'c-23' );

		$failures = new Failures( [ $a, new Failures( [ $b, $c ] ) ] );

		$this->assertSame( [ $a, $b, $c ], $failures->all() );
		$this->assertSame( '3 failures: a-21 | b-22 | c-23', $failures->getMessage() );
	}

	public function test_fewer_than_two_failures_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		new Failures( [ new \RuntimeException( 'lonely-31' ) ] );
	}

	public function test_it_takes_a_keyed_array(): void {
		$first  = new \RuntimeException( 'spoke-a-41' );
		$second = new \RuntimeException( 'spoke-b-42' );

		$this->assertSame( [ $first, $second ], ( new Failures( [ 'a' => $first, 'b' => $second ] ) )->all() );
	}

	public function test_the_message_is_bounded_and_counts_the_members_it_leaves_out(): void {
		$members = [];
		for ( $i = 0; $i < 3000; $i++ ) {
			$members[] = new \RuntimeException( \sprintf( 'event-%04d ', $i ) . \str_repeat( 'x', 90 ) );
		}

		$failures = new Failures( $members );
		$message  = $failures->getMessage();

		$this->assertCount( 3000, $failures->all(), 'all() keeps every member' );
		$this->assertLessThanOrEqual( Failures::MESSAGE_BUDGET, \strlen( $message ) );
		$this->assertGreaterThan( Failures::MESSAGE_BUDGET - 200, \strlen( $message ), 'the budget is spent, not wasted' );
		$this->assertStringStartsWith( '3000 failures: event-0000 ', $message );
		$this->assertSame( 1, \preg_match( '/ \| (event-(\d{4}) x+) … and (\d+) more$/', $message, $m ) );
		$this->assertSame( $members[ (int) $m[2] ]->getMessage(), $m[1], 'the last member shown is whole' );
		$this->assertSame( 3000 - 1 - (int) $m[2], (int) $m[3] );
	}

	public function test_it_reports_the_origin_of_its_first_failure(): void {
		$first  = new \RuntimeException( 'origin-41' );
		$second = new \LogicException( 'other-42' );

		$failures = new Failures( [ $first, $second ] );

		$this->assertSame( __FILE__, $failures->getFile() );
		$this->assertSame( $first->getLine(), $failures->getLine() );
		$this->assertNotSame( $second->getLine(), $failures->getLine() );
	}

	public function test_a_nested_failures_reports_the_origin_of_the_first_flattened_member(): void {
		$a = new \RuntimeException( 'a-51' );
		$b = new \RuntimeException( 'b-52' );
		$c = new \RuntimeException( 'c-53' );

		$failures = new Failures( [ new Failures( [ $a, $b ] ), $c ] );

		$this->assertSame( $a->getLine(), $failures->getLine() );
	}
}
