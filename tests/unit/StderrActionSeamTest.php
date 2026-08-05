<?php
/**
 * StderrActionSeamTest: the `newspack_nodes/stderr` action seam.
 *
 * Core::stderr() fires one action per emitted line so an application (ELN)
 * can bridge diagnostic lines into its firehose without replacing the handler.
 * The action must fire under the $in_stderr re-entry guard so a listener that
 * itself logs cannot recurse.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Core::class )]
class StderrActionSeamTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions'] = [];
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_actions'] = [];
		parent::tearDown();
	}

	public function test_stderr_fires_action_with_the_emitted_line(): void {
		$captured = [];
		\add_action( 'newspack_nodes/stderr', static function ( string $line ) use ( &$captured ): void {
			$captured[] = $line;
		} );

		Core::stderr( 'boom-distinct-marker-9137' );

		$this->assertCount( 1, $captured );
		$this->assertStringContainsString( 'boom-distinct-marker-9137', $captured[0] );
	}

	public function test_print_less_often_reaches_the_stderr_action(): void {
		$captured = [];
		\add_action( 'newspack_nodes/stderr', static function ( string $line ) use ( &$captured ): void {
			$captured[] = $line;
		} );

		Core::print_less_often( 'unique-throttle-key-4471 ', 'payload-xyz' );

		$this->assertCount( 1, $captured );
		$this->assertStringContainsString( 'unique-throttle-key-4471', $captured[0] );
	}

	public function test_a_throwing_listener_neither_escapes_nor_skips_the_handler(): void {
		// The diagnostic last-resort path must not be breakable by a listener:
		// its throw is swallowed and the real stderr handler still runs.
		\add_action( 'newspack_nodes/stderr', static function (): void {
			throw new \RuntimeException( 'listener-blew-up-6634' );
		} );
		$handled = [];
		Core::set_stderr_handler( static function ( string $line ) use ( &$handled ): void {
			$handled[] = $line;
		} );

		Core::stderr( 'must-still-arrive-3319' );

		$this->assertCount( 1, $handled );
		$this->assertStringContainsString( 'must-still-arrive-3319', $handled[0] );
	}

	public function test_listener_that_logs_does_not_recurse(): void {
		// A listener that itself calls Core::stderr() must not re-fire the action:
		// the nested _stderr() short-circuits under the $in_stderr guard.
		$count = 0;
		\add_action( 'newspack_nodes/stderr', static function ( string $line ) use ( &$count ): void {
			++$count;
			Core::stderr( 'nested-from-listener-2260' );
		} );

		Core::stderr( 'outer-line-8802' );

		$this->assertSame( 1, $count );
	}
}
