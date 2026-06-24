<?php
namespace Newspack_Nodes\Tests\Unit\ConfigSystem;

use Newspack_Nodes\Config_System\Options_Overlay;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Options_Overlay::class )]
class OptionsOverlayTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_options'] = [];
	}

	public function test_absent_option_keeps_file_default(): void {
		$result = Options_Overlay::apply( [ 'num_partitions' => 1 ], [ 'num_partitions' ], 'tp_' );
		$this->assertSame( 1, $result['num_partitions'] );
	}

	public function test_present_option_overrides_default(): void {
		\update_option( 'tp_num_partitions', '8' );
		$result = Options_Overlay::apply( [ 'num_partitions' => 1 ], [ 'num_partitions' ], 'tp_' );
		$this->assertSame( '8', $result['num_partitions'] );
	}

	public function test_present_empty_value_overrides_default(): void {
		// Presence decides, not emptiness: a stored '' / [] / false / 0 wins.
		\update_option( 'tp_topologies', [] );
		\update_option( 'tp_base_directory', '' );
		$result = Options_Overlay::apply(
			[ 'topologies' => [ 'x' ], 'base_directory' => '/d' ],
			[ 'topologies', 'base_directory' ],
			'tp_'
		);
		$this->assertSame( [], $result['topologies'] );
		$this->assertSame( '', $result['base_directory'] );
	}

	public function test_unschemad_keys_are_untouched(): void {
		\update_option( 'tp_num_partitions', '8' );
		$result = Options_Overlay::apply( [ 'kept' => 'yes' ], [ 'num_partitions' ], 'tp_' );
		$this->assertSame( 'yes', $result['kept'] );
	}

	public function test_stored_value_returns_absent_sentinel_for_missing_option(): void {
		$this->assertSame( Options_Overlay::ABSENT, Options_Overlay::stored_value( 'tp_', 'num_partitions' ) );
	}

	public function test_stored_value_returns_value_when_present(): void {
		\update_option( 'tp_num_partitions', '8' );
		$this->assertSame( '8', Options_Overlay::stored_value( 'tp_', 'num_partitions' ) );
	}

	public function test_stored_value_returns_value_for_present_empty_option(): void {
		// Presence decides, not emptiness: a stored '' is NOT the absent sentinel.
		\update_option( 'tp_base_directory', '' );
		$this->assertSame( '', Options_Overlay::stored_value( 'tp_', 'base_directory' ) );
	}
}
