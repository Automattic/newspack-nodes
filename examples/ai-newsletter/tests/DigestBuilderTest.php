<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-digest-builder.php';

use Newspack_AI_Newsletter\Digest_Builder_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

final class DigestBuilderTest extends TestCase {
	private function summary( string $s ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = [ 'source' => 'x', 'title' => $s, 'summary' => "sum:$s" ];
		return $m;
	}

	public function test_flush_emits_markdown_with_all_summaries_then_clears(): void {
		$sink = new Capture_Sink_Node();
		$node = new Digest_Builder_Node();
		$node->sink( $sink );

		foreach ( [ 'a', 'b', 'c' ] as $s ) {
			$msg = $this->summary( $s );
			$node->fill( $msg );
		}
		$node->cmd_flush();

		$out = $sink->captured;
		$this->assertCount( 1, $out, 'one draft emitted' );
		$draft = $out[0];
		$this->assertSame( Message::TM_BYTESTREAM, $draft[ Message::TYPE ] & Message::TM_BYTESTREAM );
		$this->assertIsString( $draft[ Message::VALUE ] );
		foreach ( [ 'sum:a', 'sum:b', 'sum:c' ] as $needle ) {
			$this->assertStringContainsString( $needle, $draft[ Message::VALUE ] );
		}

		// Second flush with nothing accumulated proves the buffer cleared.
		$node->cmd_flush();
		$out2 = $sink->captured;
		$this->assertCount( 2, $out2 );
		$this->assertStringNotContainsString( 'sum:a', $out2[1][ Message::VALUE ] );
	}

	public function test_ignores_non_struct_messages(): void {
		$sink = new Capture_Sink_Node();
		$node = new Digest_Builder_Node();
		$node->sink( $sink );
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'noise';
		$node->fill( $m );
		$node->cmd_flush();
		// Only the (empty) draft from flush; the noise was not accumulated.
		$this->assertStringNotContainsString( 'noise', $sink->captured[0][ Message::VALUE ] );
	}

	public function test_emitted_draft_carries_TO_from_target(): void {
		$sink = new Capture_Sink_Node();
		$node = new Digest_Builder_Node();
		$node->sink( $sink );
		$node->connect_node( 'out' );

		$msg = $this->summary( 'a' );
		$node->fill( $msg );
		$node->cmd_flush();

		$this->assertNotEmpty( $sink->captured );
		foreach ( $sink->captured as $m ) {
			$this->assertSame( 'out', $m[ Message::TO ] );
		}
	}
}
