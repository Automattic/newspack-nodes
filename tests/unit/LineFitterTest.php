<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Line_Fitter;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;

/**
 * Line_Fitter — the shared packed-size fit: halve an ordered list of trimmable
 * VALUE string fields until the packed line (+ newline) is under the Partition
 * PIPE_BUF cap; null when nothing is left to cut. Used by every ELN emit whose
 * partition doesn't lift the cap (errors / completed / gyroscope).
 */
#[CoversClass( Line_Fitter::class )]
class LineFitterTest extends TestCase {

	/** @param array<string, mixed> $value */
	private function struct( array $value ): array {
		$m                     = Message::new_message();
		$m[ Message::TYPE ]    = Message::TM_STRUCT;
		$m[ Message::KEY ]     = 'k';
		$m[ Message::VALUE ]   = $value;
		return $m;
	}

	public function test_returns_the_message_unchanged_when_already_under_the_cap(): void {
		$fit = Line_Fitter::fit( $this->struct( [ 'm' => 'small-7811' ] ), [ 'm' ] );
		$this->assertNotNull( $fit );
		$this->assertSame( 'small-7811', $fit[ Message::VALUE ]['m'] );
	}

	public function test_halves_only_the_first_field_when_that_gets_it_under_the_cap(): void {
		$m   = $this->struct( [ 'm' => \str_repeat( 'x', 8000 ), 'url' => '/keep-7812' ] );
		$fit = Line_Fitter::fit( $m, [ 'm', 'url' ] );
		$this->assertNotNull( $fit );
		$this->assertLessThanOrEqual( Partition_Node::MAX_LINE_SIZE, Message::packed_size( $fit ) + 1 );
		$this->assertSame( '/keep-7812', $fit[ Message::VALUE ]['url'] );
	}

	public function test_moves_to_the_next_field_once_the_first_is_exhausted(): void {
		$m   = $this->struct( [ 'm' => 'x', 'url' => '/' . \str_repeat( 'u', 8000 ) ] );
		$fit = Line_Fitter::fit( $m, [ 'm', 'url' ] );
		$this->assertNotNull( $fit );
		$this->assertLessThanOrEqual( Partition_Node::MAX_LINE_SIZE, Message::packed_size( $fit ) + 1 );
		$this->assertLessThan( 8001, \strlen( $fit[ Message::VALUE ]['url'] ) );
	}

	public function test_measures_packed_bytes_not_chars_multibyte_aware(): void {
		// 1200 × '错' char-fits any 2000-char cap but JSON-escapes to ~7200 bytes.
		$m   = $this->struct( [ 'm' => \str_repeat( '错', 1200 ) ] );
		$fit = Line_Fitter::fit( $m, [ 'm' ] );
		$this->assertNotNull( $fit );
		$this->assertLessThanOrEqual( Partition_Node::MAX_LINE_SIZE, Message::packed_size( $fit ) + 1 );
	}

	public function test_returns_null_when_no_listed_field_can_shrink_it(): void {
		// A bulk field NOT in the trim list keeps the record over the cap.
		$m = $this->struct( [ 'm' => 'x', 'bulk' => \str_repeat( 'Z', 8000 ) ] );
		$this->assertNull( Line_Fitter::fit( $m, [ 'm', 'url' ] ) );
	}
}
