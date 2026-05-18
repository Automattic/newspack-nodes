<?php
/**
 * ServiceCITest: unit tests for the Service_CI base class — three shared
 * verb-helper seams (require_manage_options, decode_args, require_valid_name)
 * that substrate + application CIs both reach for. Tests exercise each
 * helper via a transparent subclass that exposes them publicly so the
 * helpers can be asserted in isolation, without dragging in VerbHarness +
 * the request-scope CI graph.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Service_CI;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Service_CI::class )]
class ServiceCITest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// Deny by default so the manage_options happy path is explicit.
		$GLOBALS['_wp_test_current_user_can'] = [];
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		parent::tearDown();
	}

	// ── require_manage_options ───────────────────────────────────────────────

	public function test_require_manage_options_passes_when_capability_granted(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		// No assertion needed — just confirm it doesn't throw.
		ServiceCITestProbe::require_manage_options_probe();
		$this->assertTrue( true );
	}

	public function test_require_manage_options_throws_when_capability_denied(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'permission denied: manage_options required' );
		ServiceCITestProbe::require_manage_options_probe();
	}

	// ── require_valid_name ───────────────────────────────────────────────────

	public function test_require_valid_name_returns_name_when_valid(): void {
		$this->assertSame(
			'my-topology_42',
			ServiceCITestProbe::require_valid_name_probe( [ 'name' => 'my-topology_42' ] )
		);
	}

	public function test_require_valid_name_throws_when_name_key_missing(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'invalid name' );
		ServiceCITestProbe::require_valid_name_probe( [] );
	}

	public function test_require_valid_name_throws_when_name_violates_default_pattern(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'invalid name' );
		ServiceCITestProbe::require_valid_name_probe( [ 'name' => 'has spaces' ] );
	}

	public function test_require_valid_name_throws_on_path_traversal_attempt(): void {
		$this->expectException( \RuntimeException::class );
		ServiceCITestProbe::require_valid_name_probe( [ 'name' => '../etc/passwd' ] );
	}

	public function test_require_valid_name_respects_custom_pattern(): void {
		// Custom pattern allows colons + dots (the layout-id pattern).
		$this->assertSame(
			'firehose:partition.config',
			ServiceCITestProbe::require_valid_name_probe(
				[ 'name' => 'firehose:partition.config' ],
				'/^[a-zA-Z0-9_:.-]+$/'
			)
		);
	}

	public function test_require_valid_name_rejects_when_custom_pattern_excludes_it(): void {
		$this->expectException( \RuntimeException::class );
		ServiceCITestProbe::require_valid_name_probe(
			[ 'name' => 'has-dash' ],
			'/^[a-zA-Z0-9_]+$/'
		);
	}
}

/**
 * Subclass that re-exports Service_CI's protected helpers as public static
 * methods. The helpers are protected because the legitimate callers are
 * subclass closures (which can use `self::`); tests need a public surface
 * to invoke them in isolation. Constructing the probe is not required —
 * the helpers are static.
 */
class ServiceCITestProbe extends Service_CI {

	public static function require_manage_options_probe(): void {
		self::require_manage_options();
	}

	public static function require_valid_name_probe(
		array $decoded,
		string $pattern = '/^[a-zA-Z0-9_-]+$/'
	): string {
		return self::require_valid_name( $decoded, $pattern );
	}
}
