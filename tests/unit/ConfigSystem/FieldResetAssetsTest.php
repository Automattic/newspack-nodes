<?php
namespace Newspack_Nodes\Tests\Unit\ConfigSystem;

use Newspack_Nodes\Config_System\Field_Reset_Assets;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Field_Reset_Assets::class )]
class FieldResetAssetsTest extends TestCase {

	public function test_enqueue_registers_the_shared_nodes_module(): void {
		$GLOBALS['_enqueued_scripts'] = [];

		Field_Reset_Assets::enqueue();

		$this->assertArrayHasKey( 'newspack-nodes-field-reset', $GLOBALS['_enqueued_scripts'] );
	}

	public function test_highlight_style_targets_the_marked_toggle(): void {
		$this->assertStringContainsString( '.is-marked [data-nn-reset-toggle]', Field_Reset_Assets::highlight_style() );
	}
}
