<?php
/**
 * The test shim's `sanitize_text_field()` against core's
 * `_sanitize_text_fields()` (wp-includes/formatting.php): what core strips,
 * the shim strips, and what core keeps — ESC and every other control
 * character outside `[\r\n\t]` — the shim keeps, so no test passes on a
 * strip production never makes.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class WpShimsSanitizeTextFieldTest extends TestCase {

	public function test_it_keeps_c0_c1_and_del_as_core_does(): void {
		$this->assertSame( "Kea\x1b[2K\x07 Desk\xC2\x9B\x7F", \sanitize_text_field( "Kea\x1b[2K\x07 Desk\xC2\x9B\x7F" ) );
	}

	public function test_it_folds_line_breaks_tabs_and_spaces_into_one_space_and_trims(): void {
		$this->assertSame( 'Tui laptop 4410', \sanitize_text_field( " \tTui\r\n\n  laptop\t4410\n " ) );
	}

	public function test_it_keeps_a_vertical_tab_and_form_feed_core_does_not_fold(): void {
		$this->assertSame( "Kea\x0B\x0CDesk", \sanitize_text_field( "Kea\x0B\x0CDesk" ) );
	}

	public function test_it_strips_tags_and_the_body_of_script_and_style(): void {
		$this->assertSame( 'Kea Desk', \sanitize_text_field( '<b>Kea</b> <script>alert(4410)</script>Desk<style>p{}</style>' ) );
	}

	public function test_it_escapes_a_lone_less_than_rather_than_dropping_the_rest(): void {
		$this->assertSame( 'Kea &lt; 4410', \sanitize_text_field( 'Kea < 4410' ) );
	}

	public function test_it_removes_percent_octets_and_the_spaces_they_leave(): void {
		$this->assertSame( 'Kea Desk', \sanitize_text_field( 'Kea %2F %41 Desk%7e' ) );
	}

	public function test_invalid_utf8_empties_the_whole_value(): void {
		$this->assertSame( '', \sanitize_text_field( "Kea \xC3\x28 Desk" ) );
	}

	public function test_an_array_or_object_answers_empty_and_a_scalar_is_cast(): void {
		$this->assertSame( '', \sanitize_text_field( [ 'Kea' ] ) );
		$this->assertSame( '', \sanitize_text_field( new \stdClass() ) );
		$this->assertSame( '7746', \sanitize_text_field( 7746 ) );
	}
}
