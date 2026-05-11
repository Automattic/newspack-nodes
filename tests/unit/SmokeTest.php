<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;

class SmokeTest extends TestCase {
	public function test_plugin_constants_defined(): void {
		$this->assertTrue( \defined( 'NEWSPACK_NODES_VERSION' ) );
		$this->assertMatchesRegularExpression( '/^\d+\.\d+\.\d+(-[\w.]+)?$/', \NEWSPACK_NODES_VERSION );
	}

	public function test_core_class_exists(): void {
		$this->assertTrue( \class_exists( '\Newspack_Nodes\Core' ) );
	}

	public function test_bounded_ticks_helper(): void {
		$cb = $this->boundedTicks( 3 );
		$this->assertTrue( $cb() );
		$this->assertTrue( $cb() );
		$this->assertTrue( $cb() );
		$this->assertFalse( $cb() );
	}
}
