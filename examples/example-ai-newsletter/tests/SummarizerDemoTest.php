<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-summarizer-demo.php';

use Example_AI_Newsletter\Summarizer_Demo_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

final class SummarizerDemoTest extends TestCase {
	private function struct( array $value ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = $value;
		return $m;
	}

	public function test_emits_summary_and_is_source_agnostic(): void {
		$sink = new Capture_Sink_Node();
		$node = new Summarizer_Demo_Node();
		$node->sink( $sink );

		foreach ( [ 'releases', 'community', 'anything-else' ] as $src ) {
			$message = $this->struct( [ 'source' => $src, 'title' => 'T', 'url' => 'u', 'body' => 'B' ] );
			$node->fill( $message );
		}

		$out = $sink->captured;
		$this->assertCount( 3, $out );
		foreach ( $out as $m ) {
			$this->assertSame( Message::TM_STRUCT, $m[ Message::TYPE ] & Message::TM_STRUCT );
			$this->assertArrayHasKey( 'summary', $m[ Message::VALUE ] );
			$this->assertNotSame( '', $m[ Message::VALUE ]['summary'] );
		}
	}

	public function test_ignores_non_struct_messages(): void {
		$sink = new Capture_Sink_Node();
		$node = new Summarizer_Demo_Node();
		$node->sink( $sink );
		$m                  = Message::new_message();
		$m[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'not a struct';
		$node->fill( $m );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_summarize_seam_is_overridable(): void {
		$this->assertTrue( method_exists( Summarizer_Demo_Node::class, 'summarize' ) );
	}

	public function test_emitted_message_carries_TO_from_target(): void {
		$sink = new Capture_Sink_Node();
		$node = new Summarizer_Demo_Node();
		$node->sink( $sink );
		$node->connect_node( 'digest' );

		$message = $this->struct( [ 'source' => 'releases', 'title' => 'T', 'url' => 'u', 'body' => 'B' ] );
		$node->fill( $message );

		$this->assertNotEmpty( $sink->captured );
		foreach ( $sink->captured as $m ) {
			$this->assertSame( 'digest', $m[ Message::TO ] );
		}
	}
}
