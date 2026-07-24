<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Age_Sieve_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Port of Tachikoma's AgeSieve.pm: drop any message whose TIMESTAMP age
 * exceeds max_age (default 900s); should_warn enables the rate-limited
 * drop warning. No type gating — age is the only criterion.
 */
#[CoversClass( Age_Sieve_Node::class )]
class AgeSieveTest extends TestCase {
	private float $prev_now;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_now = Core::$now;
		Core::$now      = 1000000.0;
	}

	protected function tearDown(): void {
		Core::$now = $this->prev_now;
		parent::tearDown();
	}

	private function sieve( array $args ): array {
		$sink  = new Capture_Sink_Node();
		$sieve = new Age_Sieve_Node();
		$sieve->name( 'jobs:sieve' );
		$sieve->sink( $sink );
		$sieve->arguments( $args );
		return [ $sieve, $sink ];
	}

	private function stamped( float $ts ): array {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = $ts;
		$message[ Message::VALUE ]     = [ 'k' => 'job' ];
		return $message;
	}

	public function test_fresh_messages_pass_and_old_ones_drop(): void {
		[ $sieve, $sink ] = $this->sieve( [ '60' ] );

		$sieve->fill( $this->stamped( Core::$now - 59.0 ) );
		$sieve->fill( $this->stamped( Core::$now - 61.0 ) );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( Core::$now - 59.0, $sink->captured[0][ Message::TIMESTAMP ] );
	}

	public function test_default_max_age_matches_tachikoma(): void {
		[ $sieve, $sink ] = $this->sieve( [] );
		$this->assertSame( 900.0, $sieve->max_age() );

		$sieve->fill( $this->stamped( Core::$now - 899.0 ) );
		$sieve->fill( $this->stamped( Core::$now - 901.0 ) );
		$this->assertCount( 1, $sink->captured );
	}

	public function test_arguments_read_back_and_schema_names_both(): void {
		[ $sieve ] = $this->sieve( [ '60', '1' ] );
		$this->assertSame( [ '60', '1' ], $sieve->arguments() );
		$this->assertSame( 'Filtering', \Newspack_Nodes\Age_Sieve_Node::node_schema()['category'] );
	}

	public function test_should_warn_drops_without_crashing(): void {
		[ $sieve, $sink ] = $this->sieve( [ '60', '1' ] );
		$sieve->fill( $this->stamped( Core::$now - 3600.0 ) );
		$this->assertSame( [], $sink->captured );
	}
}
