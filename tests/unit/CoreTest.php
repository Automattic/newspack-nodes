<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Core::class )]
class CoreTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		Core::reset();
	}

	public function test_register_and_lookup_node_by_name(): void {
		$obj = new \stdClass();
		Core::register_node( 'foo', $obj );
		$this->assertSame( $obj, Core::node( 'foo' ) );
	}

	public function test_lookup_missing_node_returns_null(): void {
		$this->assertNull( Core::node( 'nonexistent' ) );
	}

	public function test_unregister_removes_node(): void {
		Core::register_node( 'foo', new \stdClass() );
		Core::unregister_node( 'foo' );
		$this->assertNull( Core::node( 'foo' ) );
	}

	public function test_now_returns_float(): void {
		Core::$now = \microtime(true);
		$this->assertIsFloat( Core::$now );
		$this->assertIsFloat( Core::$now );
	}

	public function test_now_microsecond_precision(): void {
		Core::$now = 1234567890.123456;
		$this->assertSame( 1234567890.123456, Core::$now );
		// $now matches $now (no truncation).
		$this->assertSame( 1234567890.123456, Core::$now );
	}

	public function test_run_closing_executes_callbacks_in_order(): void {
		$order = [];
		Core::push_closing( function () use ( &$order ) { $order[] = 'a'; } );
		Core::push_closing( function () use ( &$order ) { $order[] = 'b'; } );
		Core::push_closing( function () use ( &$order ) { $order[] = 'c'; } );

		Core::run_closing();
		$this->assertSame( [ 'a', 'b', 'c' ], $order );
	}

	public function test_run_closing_drains_queue(): void {
		$count = 0;
		Core::push_closing( function () use ( &$count ) { ++$count; } );
		Core::run_closing();
		Core::run_closing(); // should be no-op now
		$this->assertSame( 1, $count );
	}

	public function test_print_less_often_emits_first_occurrence(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		Core::print_less_often( 'first warning' );
		$this->assertStringContainsString( 'first warning', $buf );
	}

	public function test_print_less_often_suppresses_within_60s(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		Core::$now = 1000.0;
		Core::print_less_often( 'duplicate' );
		Core::$now = 1030.0; // 30s later — within window
		Core::print_less_often( 'duplicate' );
		$this->assertSame( 1, \substr_count( $buf, 'duplicate' ) );
	}

	public function test_print_least_often_emits_at_tenth_call(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		for ( $i = 0; $i < 9; ++$i ) {
			Core::print_least_often( 'rare' );
		}
		$this->assertStringNotContainsString( 'rare', $buf );
		Core::print_least_often( 'rare' ); // 10th
		$this->assertStringContainsString( 'rare', $buf );
	}
}
