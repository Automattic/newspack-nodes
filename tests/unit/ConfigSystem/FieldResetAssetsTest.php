<?php
namespace Newspack_Nodes\Tests\Unit\ConfigSystem;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Config_System\Field_Reset_Assets;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Field_Reset_Assets::class )]
class FieldResetAssetsTest extends TestCase {

	public function test_enqueue_registers_the_shared_nodes_module(): void {
		$GLOBALS['_enqueued_scripts'] = [];

		Field_Reset_Assets::enqueue();

		$this->assertArrayHasKey( 'newspack-nodes-field-reset', $GLOBALS['_enqueued_scripts'] );
	}

	public function test_enqueue_brings_the_ui_sheet_that_paints_the_marked_toggle(): void {
		$GLOBALS['_enqueued_styles'] = [];

		Field_Reset_Assets::enqueue();

		// The sheet's `.button.is-danger` role is the mark's only paint, so the
		// enqueue that brings the toggle brings the sheet by handle too.
		$this->assertArrayHasKey( 'newspack-nodes-ui', $GLOBALS['_enqueued_styles'] );
	}
}
