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

	public function test_a_throwing_listener_still_reaches_the_handler_then_escapes(): void {
		// The handler runs whatever the listener threw; the throw then escapes.
		$thrown = new \RuntimeException( 'listener-blew-up-6634' );
		\add_action( 'newspack_nodes/stderr', static function () use ( $thrown ): void {
			throw $thrown;
		} );
		$handled = [];
		Core::set_stderr_handler( static function ( string $line ) use ( &$handled ): void {
			$handled[] = $line;
		} );

		$caught = null;
		try {
			Core::stderr( 'must-still-arrive-3319' );
		} catch ( \RuntimeException $e ) {
			$caught = $e;
		}
		$this->assertSame( $thrown, $caught, 'the listener failure escapes' );
		$this->assertCount( 1, $handled );
		$this->assertStringContainsString( 'must-still-arrive-3319', $handled[0] );
		$this->assertFalse( Core::in_stderr(), 'the re-entry guard resets on the way out' );
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
	public function test_stderr_fires_its_line_under_the_stderr_keyword(): void {
		$keywords = [];
		\add_action( 'newspack_nodes/stderr', static function ( string $line, string $keyword ) use ( &$keywords ): void {
			$keywords[] = $keyword;
		} );
		Core::stderr( 'keyed-line-5584' );
		$this->assertSame( [ 'stderr' ], $keywords );
	}

	public function test_stderr_to_seam_fires_its_line_under_its_own_keyword(): void {
		$fired = [];
		\add_action( 'newspack_nodes/stderr', static function ( string $line, string $keyword ) use ( &$fired ): void {
			$fired[] = $keyword;
		} );
		Core::stderr_to_seam( 'keyed-seam-5585', 'kea (stop)' );
		$this->assertSame( [ 'kea (stop)' ], $fired );
	}

	public function test_stderr_to_seam_fires_the_line_stderr_would_and_skips_the_handler(): void {
		$seam = [];
		\add_action( 'newspack_nodes/stderr', static function ( string $line ) use ( &$seam ): void {
			$seam[] = $line;
		} );
		$handled = [];
		Core::set_stderr_handler( static function ( string $line ) use ( &$handled ): void {
			$handled[] = $line;
		} );

		Core::stderr( 'both-ways-5582' );
		Core::stderr_to_seam( 'seam-only-5583', 'kea (stop)' );

		$this->assertSame( [ \str_replace( 'both-ways-5582', 'seam-only-5583', $seam[0] ) ], \array_slice( $seam, 1 ), 'the same midfixed composition' );
		$this->assertCount( 1, $handled, 'only stderr() reaches the handler, and so error_log' );
		$this->assertStringContainsString( 'seam-only-5583', (string) \end( Core::$recent_log ), 'the dmesg ring keeps it' );
	}

	public function test_stderr_to_seam_drops_an_empty_line(): void {
		$seam = [];
		\add_action( 'newspack_nodes/stderr', static function ( string $line ) use ( &$seam ): void {
			$seam[] = $line;
		} );
		Core::stderr_to_seam( '', 'kea (stop)' );
		$this->assertSame( [], $seam );
	}

	public function test_a_seam_listener_writing_to_the_seam_is_not_handed_to_error_log(): void {
		$count = 0;
		\add_action( 'newspack_nodes/stderr', static function () use ( &$count ): void {
			++$count;
			Core::stderr_to_seam( 'nested-seam-2261', 'kea (stop)' );
		} );
		$handled = [];
		Core::set_stderr_handler( static function ( string $line ) use ( &$handled ): void {
			$handled[] = $line;
		} );

		Core::stderr_to_seam( 'outer-seam-8803', 'kea (stop)' );

		$this->assertSame( 1, $count );
		$this->assertSame( [], $handled );
		$this->assertFalse( Core::in_stderr() );
	}

	public function test_a_throwing_seam_listener_escapes_and_resets_the_guard(): void {
		$thrown = new \RuntimeException( 'seam-listener-blew-up-6635' );
		\add_action( 'newspack_nodes/stderr', static function () use ( $thrown ): void {
			throw $thrown;
		} );
		$this->assertSame( $thrown, $this->caught( static fn () => Core::stderr_to_seam( 'seam-must-escape-3320', 'kea (stop)' ), 'the listener failure escapes' ) );
		$this->assertFalse( Core::in_stderr() );
	}
}
