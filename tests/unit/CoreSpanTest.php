<?php
/**
 * CoreSpanTest: the `Core::span()` seam a logger times substrate work through.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Core::class )]
final class CoreSpanTest extends TestCase {

	protected function tearDown(): void {
		Core::$around_span = null;
		parent::tearDown();
	}

	public function test_with_no_seam_the_work_runs_bare_and_its_result_returns(): void {
		$described = 0;
		$this->assertSame(
			'kea-8812',
			Core::span(
				'kea span',
				static fn (): string => 'kea-8812',
				static function () use ( &$described ): string {
					++$described;
					return 'kea detail';
				}
			)
		);
		$this->assertSame( 0, $described, 'nothing describes a span no seam times' );
	}

	public function test_the_seam_gets_the_label_the_work_and_the_description(): void {
		$seen              = [];
		Core::$around_span = static function ( string $label, \Closure $work, \Closure $describe ) use ( &$seen ): mixed {
			$result = $work();
			$seen[] = [ $label, $describe( $result ) ];
			return "wrapped {$result}";
		};

		$this->assertSame( 'wrapped 4471', Core::span( 'heron span', static fn (): int => 4471, static fn ( int $n ): string => "heron {$n}" ) );
		$this->assertSame( [ [ 'heron span', 'heron 4471' ] ], $seen );
	}
}
