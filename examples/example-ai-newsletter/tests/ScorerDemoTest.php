<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-scorer-demo.php';

use Example_AI_Newsletter\Scorer_Demo_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

final class ScorerDemoTest extends TestCase {

	private function item( array $value ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = $value;
		return $m;
	}

	public function test_adds_deterministic_score_and_forwards(): void {
		$sink = new Capture_Sink_Node();
		$node = new Scorer_Demo_Node();
		$node->sink( $sink );

		$message = $this->item( [ 'source' => 'releases', 'title' => 'Roundup Block ships', 'summary' => 's' ] );
		$node->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$out = $sink->captured[0];
		$this->assertSame( Message::TM_STRUCT, $out[ Message::TYPE ] & Message::TM_STRUCT );
		$this->assertIsArray( $out[ Message::VALUE ] );
		$this->assertArrayHasKey( 'score', $out[ Message::VALUE ] );
		// releases weight 5.0 + keyword "ships" 1.0 = 6.0 — deterministic.
		$this->assertSame( 6.0, $out[ Message::VALUE ]['score'] );
		// Same input → same score (no clock/random).
		$message2 = $this->item( [ 'source' => 'releases', 'title' => 'Roundup Block ships', 'summary' => 's' ] );
		$node->fill( $message2 );
		$this->assertSame( 6.0, $sink->captured[1][ Message::VALUE ]['score'] );
	}

	public function test_unknown_source_gets_base_weight(): void {
		$sink = new Capture_Sink_Node();
		$node = new Scorer_Demo_Node();
		$node->sink( $sink );
		$message = $this->item( [ 'source' => 'mystery', 'title' => 'nothing notable', 'summary' => 's' ] );
		$node->fill( $message );
		$this->assertSame( 1.0, $sink->captured[0][ Message::VALUE ]['score'] );
	}

	public function test_keyword_match_is_word_bounded_not_substring(): void {
		$sink = new Capture_Sink_Node();
		$node = new Scorer_Demo_Node();
		$node->sink( $sink );
		// "Garage" must not match 'GA', "awarded" must not match 'award' — whole words only.
		$message = $this->item( [ 'source' => 'community', 'title' => 'Garage cleanup awarded', 'summary' => 's' ] );
		$node->fill( $message );
		// community base 3.0, no whole-word keyword → 3.0 (substring matching would give 5.0).
		$this->assertSame( 3.0, $sink->captured[0][ Message::VALUE ]['score'] );
	}

	public function test_ignores_non_struct(): void {
		$sink = new Capture_Sink_Node();
		$node = new Scorer_Demo_Node();
		$node->sink( $sink );
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'noise';
		$node->fill( $m );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_emitted_item_carries_TO_from_target(): void {
		$sink = new Capture_Sink_Node();
		$node = new Scorer_Demo_Node();
		$node->sink( $sink );
		$node->connect_node( 'scored:partition' );
		$message = $this->item( [ 'source' => 'community', 'title' => 'x', 'summary' => 's' ] );
		$node->fill( $message );
		$this->assertSame( 'scored:partition', $sink->captured[0][ Message::TO ] );
	}
}
