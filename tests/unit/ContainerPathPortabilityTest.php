<?php
/**
 * Executable test helpers must be checkout-relative.
 *
 * @package Newspack_Nodes\Tests\Unit
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\TestCase;

class ContainerPathPortabilityTest extends TestCase {
	public function test_test_entry_points_do_not_assume_a_container_or_checkout_path(): void {
		$root = \dirname( __DIR__, 2 );
		$run  = (string) \file_get_contents( $root . '/tests/run.sh' );
		$xml  = (string) \file_get_contents( $root . '/examples/example-ai-newsletter/tests/phpunit.xml' );

		$this->assertStringNotContainsString( 'docker exec', $run );
		$this->assertStringNotContainsString( 'eve-pyrobase', $run );
		$this->assertStringNotContainsString( '/usr/src/newspack-nodes', $run . $xml );
	}
}
