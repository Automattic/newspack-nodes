<?php
namespace Newspack_Nodes\Tests\Unit\ConfigSystem;

use Newspack_Nodes\Config_System\Reset_Gate;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Reset_Gate::class )]
class ResetGateTest extends TestCase {

	private const MARK = 'tp_reset';

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_options'] = [];
		unset( $_POST[ self::MARK ] );
	}

	protected function tearDown(): void {
		unset( $_POST[ self::MARK ] );
		parent::tearDown();
	}

	public function test_reset_marked_option_is_deleted_for_any_field_type(): void {
		// A reset mark deletes even a selection key (NOT in the text-like list).
		$GLOBALS['_wp_options']['tp_topologies'] = [ 'a' ];
		$_POST[ self::MARK ]                     = [ 'tp_topologies' => '1' ];

		$result = Reset_Gate::resolve( [ 'a' ], [ 'a' ], 'tp_topologies', self::MARK, [ 'tp_base' ] );

		$this->assertArrayNotHasKey( 'tp_topologies', $GLOBALS['_wp_options'] );
		$this->assertSame( [ 'a' ], $result, 'returns old value to short-circuit the write' );
	}

	public function test_blank_text_like_option_is_deleted(): void {
		$GLOBALS['_wp_options']['tp_base'] = '/old';
		$result = Reset_Gate::resolve( '', '/old', 'tp_base', self::MARK, [ 'tp_base' ] );
		$this->assertArrayNotHasKey( 'tp_base', $GLOBALS['_wp_options'] );
		$this->assertSame( '/old', $result );
	}

	public function test_unmarked_nontext_empty_value_passes_through(): void {
		// Empty selection with no reset mark is a real override — keep it.
		$result = Reset_Gate::resolve( [], [ 'a' ], 'tp_topologies', self::MARK, [ 'tp_base' ] );
		$this->assertSame( [], $result );
	}

	public function test_nonblank_value_passes_through(): void {
		$result = Reset_Gate::resolve( '12', '9', 'tp_base', self::MARK, [ 'tp_base' ] );
		$this->assertSame( '12', $result );
	}

	public function test_mark_name_builds_the_hidden_input_name(): void {
		$this->assertSame( 'tp_reset[tp_base]', Reset_Gate::mark_name( self::MARK, 'tp_base' ) );
	}

	public function test_register_wires_each_option_to_the_reset_gate(): void {
		$GLOBALS['_wp_options']['tp_base'] = '/stored';

		Reset_Gate::register( self::MARK, [ 'tp_base', 'tp_topologies' ], [ 'tp_base' ] );

		$this->assertArrayHasKey( 'pre_update_option_tp_base', $GLOBALS['_wp_actions'] );
		$this->assertArrayHasKey( 'pre_update_option_tp_topologies', $GLOBALS['_wp_actions'] );

		$result = \apply_filters( 'pre_update_option_tp_base', '', '/stored', 'tp_base' );

		$this->assertArrayNotHasKey( 'tp_base', $GLOBALS['_wp_options'] );
		$this->assertSame( '/stored', $result );
	}
}
