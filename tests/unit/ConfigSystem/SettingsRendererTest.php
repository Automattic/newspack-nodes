<?php
/**
 * SettingsRendererTest: the shared field-markup renderers — the per-field reset
 * wrapper (`data-nn-reset` + `↺`) plus the generic number / directory / textarea
 * / checkbox-list controls. One home for the markup the three plugins used to
 * copy-paste, and the place the half-wired `data-nn-reset-default` checkbox hint
 * is finally emitted (so a checkbox ↺ restores the shipped default, not "all off").
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit\ConfigSystem;

use Newspack_Nodes\Config_System\Settings_Renderer;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Settings_Renderer::class )]
class SettingsRendererTest extends TestCase {

	public function test_reset_wrapper_wraps_inner_and_adds_the_toggle(): void {
		$html = Settings_Renderer::reset_wrapper( 'pfx_reset[pfx_foo]', '<span>INNER</span>' );
		$this->assertStringContainsString( 'data-nn-reset="pfx_reset[pfx_foo]"', $html );
		$this->assertStringContainsString( '<span>INNER</span>', $html );
		$this->assertStringContainsString( 'data-nn-reset-toggle', $html );
		$this->assertStringContainsString( '↺', $html );
	}

	public function test_number_renders_input_with_name_id_bounds_and_placeholder(): void {
		$html = Settings_Renderer::number(
			'num_partitions',
			'newspack_nodes_num_partitions',
			'',          // stored value (unset)
			1,           // default
			1,           // min
			16,          // max
			'Number of log partitions.',
			'mark'
		);
		$this->assertStringContainsString( 'type="number"', $html );
		$this->assertStringContainsString( 'id="num_partitions"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_num_partitions"', $html );
		$this->assertStringContainsString( 'min="1"', $html );
		$this->assertStringContainsString( 'max="16"', $html );
		$this->assertStringContainsString( 'placeholder="1"', $html );
		$this->assertStringContainsString( 'Number of log partitions.', $html );
		$this->assertStringContainsString( 'data-nn-reset="mark"', $html );
	}

	public function test_number_shows_blank_when_value_equals_default(): void {
		// Unset OR equal-to-default → placeholder (empty value); a real override shows.
		$at_default = Settings_Renderer::number( 'f', 'opt', '4', 4, 1, 32, 'd', 'm' );
		$this->assertStringContainsString( 'value=""', $at_default );
		$override = Settings_Renderer::number( 'f', 'opt', '8', 4, 1, 32, 'd', 'm' );
		$this->assertStringContainsString( 'value="8"', $override );
	}

	public function test_number_input_class_tracks_magnitude(): void {
		// Large max → regular-text; small max → small-text (matches the prior renderer).
		$this->assertStringContainsString( 'class="regular-text"', Settings_Renderer::number( 'f', 'o', '', 1, 0, 536870912, 'd', 'm' ) );
		$this->assertStringContainsString( 'class="small-text"', Settings_Renderer::number( 'f', 'o', '', 1, 1, 16, 'd', 'm' ) );
	}

	public function test_directory_renders_text_input_with_default_placeholder(): void {
		$html = Settings_Renderer::directory( 'base_directory', 'newspack_nodes_base_directory', '', '/tmp/newspack-nodes', 'Base directory.', 'mark' );
		$this->assertStringContainsString( 'type="text"', $html );
		$this->assertStringContainsString( 'id="base_directory"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_base_directory"', $html );
		$this->assertStringContainsString( 'class="regular-text code"', $html );
		$this->assertStringContainsString( 'placeholder="/tmp/newspack-nodes"', $html );
		$this->assertStringContainsString( 'Base directory.', $html );
	}

	public function test_textarea_renders_value_and_placeholder(): void {
		$html = Settings_Renderer::textarea( 'memcache_servers', 'newspack_nodes_memcache_servers', "a:1\nb:2", "127.0.0.1:11211", 'Servers.', 'mark' );
		$this->assertStringContainsString( '<textarea', $html );
		$this->assertStringContainsString( 'id="memcache_servers"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_memcache_servers"', $html );
		$this->assertStringContainsString( "a:1\nb:2", $html );
		$this->assertStringContainsString( 'placeholder="127.0.0.1:11211"', $html );
	}

	public function test_checkbox_list_marks_checked_and_emits_default_hint_per_box(): void {
		$html = Settings_Renderer::checkbox_list(
			'newspack_nodes_topologies[]',
			[ 'alpha', 'beta', 'gamma' ], // available
			[ 'alpha', 'gamma' ],          // currently checked
			[ 'alpha', 'beta' ],           // file-default set (the ↺ target)
			'Pick topologies.',
			'mark'
		);
		// Currently-checked boxes carry `checked`.
		$this->assertMatchesRegularExpression( '/value="alpha"[^>]*checked/', $html );
		$this->assertMatchesRegularExpression( '/value="gamma"[^>]*checked/', $html );
		$this->assertDoesNotMatchRegularExpression( '/value="beta"[^>]*checked/', $html );
		// THE FIX: each box advertises whether it is in the shipped default set,
		// so a ↺ reset restores that set instead of clearing everything.
		$this->assertMatchesRegularExpression( '/value="alpha"[^>]*data-nn-reset-default="1"/', $html );
		$this->assertMatchesRegularExpression( '/value="beta"[^>]*data-nn-reset-default="1"/', $html );
		$this->assertMatchesRegularExpression( '/value="gamma"[^>]*data-nn-reset-default="0"/', $html );
	}

	public function test_renderers_escape_attributes(): void {
		// A hostile value must not break out of the attribute.
		$html = Settings_Renderer::directory( 'f', 'opt', '"><script>x</script>', '', 'd', 'm' );
		$this->assertStringNotContainsString( '<script>x</script>', $html );
	}
}
