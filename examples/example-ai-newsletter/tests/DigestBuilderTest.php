<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-digest-builder.php';

use Example_AI_Newsletter\Digest_Builder_Node;
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

	public function test_flush_verb_is_dispatchable_via_config_interpreter(): void {
		// The `flush` command must be reachable through the auto-wired {name}:config
		// sibling interpreter, not only via a direct cmd_flush() call. The node opts
		// into Schema_Reflection and calls auto_wire_interpreter() in its ctor.
		$node = new Digest_Builder_Node();
		$node->name( 'digest' );

		$interpreter = $node->interpreter();
		$this->assertInstanceOf( \Newspack_Nodes\Command_Interpreter_Node::class, $interpreter );
		$this->assertSame( 'digest:config', $interpreter->name() );
		$this->assertArrayHasKey( 'flush', $interpreter->commands() );
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

	public function test_save_state_returns_accumulated_items(): void {
		$node = new Digest_Builder_Node();
		$a    = $this->summary( 'a' );
		$node->fill( $a );
		$b = $this->summary( 'b' );
		$node->fill( $b );
		$state = $node->save_state();
		$this->assertArrayHasKey( 'items', $state );
		$this->assertCount( 2, $state['items'] );
		$this->assertSame( 'sum:a', $state['items'][0]['summary'] );
	}

	public function test_restore_state_repopulates_so_flush_emits_them(): void {
		$sink = new Capture_Sink_Node();
		$node = new Digest_Builder_Node();
		$node->sink( $sink );
		$node->restore_state( [ 'items' => [
			[ 'source' => 'x', 'title' => 't', 'summary' => 'sum:restored' ],
		] ] );
		$node->cmd_flush();
		$this->assertStringContainsString( 'sum:restored', $sink->captured[0][ Message::VALUE ] );
	}

	public function test_save_restore_round_trip_is_lossless(): void {
		$a = new Digest_Builder_Node();
		$m = $this->summary( 'a' );
		$a->fill( $m );
		// Model the real transport: the snapshot crosses a JSON boundary in the offsetlog.
		$transported = \json_decode( (string) \json_encode( $a->save_state() ), true );
		$b           = new Digest_Builder_Node();
		$b->restore_state( $transported );
		$this->assertEquals( $a->save_state(), $b->save_state() );
	}

	public function test_restore_state_ignores_malformed_payload(): void {
		$node = new Digest_Builder_Node();
		$node->restore_state( [ 'items' => 'not-an-array' ] );
		$this->assertSame( [ 'items' => [] ], $node->save_state() );
	}
}
