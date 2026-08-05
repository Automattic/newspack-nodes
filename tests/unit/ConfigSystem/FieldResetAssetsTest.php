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

	public function test_highlight_style_targets_the_marked_toggle(): void {
		$this->assertStringContainsString( '.is-marked [data-nn-reset-toggle]', Field_Reset_Assets::highlight_style() );
	}

	public function test_highlight_style_reasserts_red_on_focus(): void {
		// WP core's `.wp-core-ui .button:focus` (specificity 0,3,0) otherwise
		// overrides the marked-state background, hiding the red the instant the
		// button is clicked. A focus rule at matching specificity must re-assert
		// the red so the state stays visible under the focus ring.
		$style = Field_Reset_Assets::highlight_style();
		$this->assertStringContainsString( '[data-nn-reset-toggle]:focus', $style );
		$this->assertMatchesRegularExpression(
			'/\[data-nn-reset-toggle\]:focus[^{]*\{[^}]*background:#[0-9a-fA-F]{6}/',
			$style
		);
	}
}
