<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;

class SmokeTest extends TestCase {
	public function test_plugin_constants_defined(): void {
		$this->assertTrue( \defined( 'NEWSPACK_NODES_VERSION' ) );
		$this->assertSame( '0.1.0', \NEWSPACK_NODES_VERSION );
	}

	public function test_core_class_exists(): void {
		$this->assertTrue( \class_exists( '\Newspack_Nodes\Core' ) );
	}
}
