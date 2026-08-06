<?php
/**
 * The shared test harness must neutralize process-static seams between tests so
 * one class can't poison another's Bootstrap::supervisor(). This is the
 * order-dependent flake class: a fake supervisor_factory bound to /tmp leaks out
 * of the class that set it, and a later deactivate test's kill_readers drops its
 * restart flags on the wrong base_dir — "partition p0 must have restart flag
 * dropped" fails though the code is correct.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Tests\TestCase;

final class HarnessIsolationTest extends TestCase {

	public function test_setup_clears_a_leaked_supervisor_factory(): void {
		Bootstrap::$supervisor_factory = static fn (): Spawn_Coordinator => new Spawn_Coordinator( '/tmp', 'salt' );

		$this->setUp();

		$this->assertNull(
			Bootstrap::$supervisor_factory,
			'setUp() must reset Bootstrap::$supervisor_factory so a fake bound to /tmp cannot leak into a later class and misdirect kill_readers'
		);
	}

	public function test_setup_clears_a_leaked_supervisor_enabled_override(): void {
		Bootstrap::$supervisor_enabled_override = false;

		$this->setUp();

		$this->assertNull(
			Bootstrap::$supervisor_enabled_override,
			'setUp() must reset Bootstrap::$supervisor_enabled_override so a leaked false cannot disable the fleet in a later class'
		);
	}
}
