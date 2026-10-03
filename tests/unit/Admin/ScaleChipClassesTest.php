<?php
/**
 * ScaleChipClassesTest: `Admin::scale_chip_classes()`, the substrate's one owner
 * of the scale-chip class.
 *
 * Keys rank by weight, the heaviest lightest; the ranks spread evenly onto
 * 1..SCALE_CHIP_STEPS. Keys of equal weight share the lighter rank.
 *
 * @package Newspack_Nodes
 */

namespace {
	require_once \dirname( __DIR__, 3 ) . '/includes/admin/class-admin.php';
}

namespace Newspack_Nodes\Tests\Unit\Admin {

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Admin\Admin;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Admin::class )]
class ScaleChipClassesTest extends TestCase {

	/**
	 * @param array<string,int|float> $weights
	 * @return array<string,int> Step by key.
	 */
	private function steps( array $weights ): array {
		return \array_map(
			static function ( string $class ): int {
				\preg_match( '/np-scale-chip--(\d+)$/', $class, $match );
				return (int) $match[1];
			},
			Admin::scale_chip_classes( $weights )
		);
	}

	public function test_every_key_gets_a_theme_scoped_class_and_the_heaviest_is_lightest(): void {
		$this->assertSame(
			[
				'a' => 'newspack-nodes-theme np-scale-chip--6',
				'b' => 'newspack-nodes-theme np-scale-chip--1',
				'c' => 'newspack-nodes-theme np-scale-chip--4',
			],
			Admin::scale_chip_classes( [ 'a' => 10, 'b' => 30, 'c' => 20 ] )
		);
	}

	public function test_six_keys_take_steps_one_through_six(): void {
		$this->assertSame(
			[ 'f' => 6, 'e' => 5, 'd' => 4, 'c' => 3, 'b' => 2, 'a' => 1 ],
			$this->steps( [ 'f' => 6, 'e' => 50, 'd' => 400, 'c' => 3000, 'b' => 20000, 'a' => 100000 ] )
		);
	}

	public function test_equal_weights_share_the_lighter_rank(): void {
		$this->assertSame( [ 'x' => 1, 'y' => 1, 'z' => 6 ], $this->steps( [ 'x' => 5, 'y' => 5, 'z' => 1 ] ) );
	}

	public function test_nine_keys_stay_within_the_steps_and_never_lighten_as_weight_falls(): void {
		$weights = [];
		foreach ( \range( 1, 9 ) as $n ) {
			$weights[ "k{$n}" ] = $n * 7;
		}
		$steps = $this->steps( $weights );
		$this->assertSame( 1, $steps['k9'] );
		$this->assertSame( Admin::SCALE_CHIP_STEPS, $steps['k1'] );
		$ordered = \array_values( \array_reverse( $steps ) );
		$sorted  = $ordered;
		\sort( $sorted );
		$this->assertSame( $sorted, $ordered );
		$this->assertLessThanOrEqual( Admin::SCALE_CHIP_STEPS, \max( $steps ) );
	}

	public function test_a_lone_key_takes_the_lightest_step(): void {
		$this->assertSame( [ 'only' => 'newspack-nodes-theme np-scale-chip--1' ], Admin::scale_chip_classes( [ 'only' => 3 ] ) );
	}

	public function test_an_empty_map_ranks_nothing(): void {
		$this->assertSame( [], Admin::scale_chip_classes( [] ) );
	}
}

}
