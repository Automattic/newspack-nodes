<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-digest-builder-demo.php';

use Example_AI_Newsletter\Digest_Builder_Demo_Node;
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

	/** Build a FLUSH request as the REPL's `request_node digest FLUSH` would mint it. */
	private function flush_request(): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_REQUEST;
		$m[ Message::FROM ]  = '_repl';
		$m[ Message::VALUE ] = 'FLUSH';
		return $m;
	}

	/** The accumulated drafts captured by the sink (TM_BYTESTREAM, not the response). */
	private function drafts( Capture_Sink_Node $sink ): array {
		return array_values( array_filter(
			$sink->captured,
			static fn ( $m ) => 0 !== ( $m[ Message::TYPE ] & Message::TM_BYTESTREAM )
		) );
	}

	public function test_flush_request_emits_markdown_with_all_summaries_then_clears(): void {
		$sink = new Capture_Sink_Node();
		$node = new Digest_Builder_Demo_Node();
		$node->sink( $sink );

		foreach ( [ 'a', 'b', 'c' ] as $s ) {
			$msg = $this->summary( $s );
			$node->fill( $msg );
		}
		$req = $this->flush_request();
		$node->fill( $req );

		$out = $this->drafts( $sink );
		$this->assertCount( 1, $out, 'one draft emitted' );
		$draft = $out[0];
		$this->assertSame( Message::TM_BYTESTREAM, $draft[ Message::TYPE ] & Message::TM_BYTESTREAM );
		$this->assertIsString( $draft[ Message::VALUE ] );
		foreach ( [ 'sum:a', 'sum:b', 'sum:c' ] as $needle ) {
			$this->assertStringContainsString( $needle, $draft[ Message::VALUE ] );
		}

		// Second flush with nothing accumulated proves the buffer cleared.
		$req2 = $this->flush_request();
		$node->fill( $req2 );
		$out2 = $this->drafts( $sink );
		$this->assertCount( 2, $out2 );
		$this->assertStringNotContainsString( 'sum:a', $out2[1][ Message::VALUE ] );
	}

	public function test_flush_request_replies_with_count_to_caller(): void {
		$sink = new Capture_Sink_Node();
		$node = new Digest_Builder_Demo_Node();
		$node->sink( $sink );

		foreach ( [ 'a', 'b' ] as $s ) {
			$msg = $this->summary( $s );
			$node->fill( $msg );
		}
		$req = $this->flush_request();
		$node->fill( $req );

		$replies = array_values( array_filter(
			$sink->captured,
			static fn ( $m ) => 0 !== ( $m[ Message::TYPE ] & Message::TM_RESPONSE )
		) );
		$this->assertCount( 1, $replies, 'exactly one TM_RESPONSE reply' );
		$reply = $replies[0];
		$this->assertSame( Message::TM_STRUCT, $reply[ Message::TYPE ] & Message::TM_STRUCT );
		$this->assertSame( '_repl', $reply[ Message::TO ], 'reply goes to TO=FROM' );
		$this->assertSame( 'FLUSH', $reply[ Message::VALUE ]['verb'] );
		$this->assertSame( 2, $reply[ Message::VALUE ]['data']['flushed'] );
	}

	public function test_flush_request_verb_is_documented_in_schema(): void {
		// FLUSH is a runtime trigger: a TM_REQUEST handled in fill(), documented
		// under node_schema()['requests'] (NOT a TM_COMMAND verb under 'commands').
		$schema = Digest_Builder_Demo_Node::node_schema();
		$this->assertArrayHasKey( 'requests', $schema );
		$names = array_column( $schema['requests'], 'name' );
		$this->assertContains( 'FLUSH', $names );
	}

	public function test_ignores_non_struct_messages(): void {
		$sink = new Capture_Sink_Node();
		$node = new Digest_Builder_Demo_Node();
		$node->sink( $sink );
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'noise';
		$node->fill( $m );
		$req = $this->flush_request();
		$node->fill( $req );
		// Only the (empty) draft from flush; the noise was not accumulated.
		$this->assertStringNotContainsString( 'noise', $this->drafts( $sink )[0][ Message::VALUE ] );
	}

	public function test_emitted_draft_carries_TO_from_target(): void {
		$sink = new Capture_Sink_Node();
		$node = new Digest_Builder_Demo_Node();
		$node->sink( $sink );
		$node->connect_node( 'out' );

		$msg = $this->summary( 'a' );
		$node->fill( $msg );
		$req = $this->flush_request();
		$node->fill( $req );

		$drafts = $this->drafts( $sink );
		$this->assertNotEmpty( $drafts );
		foreach ( $drafts as $m ) {
			$this->assertSame( 'out', $m[ Message::TO ] );
		}
	}

	public function test_save_state_returns_accumulated_items(): void {
		$node = new Digest_Builder_Demo_Node();
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
		$node = new Digest_Builder_Demo_Node();
		$node->sink( $sink );
		$node->restore_state( [ 'items' => [
			[ 'source' => 'x', 'title' => 't', 'summary' => 'sum:restored' ],
		] ] );
		$req = $this->flush_request();
		$node->fill( $req );
		$this->assertStringContainsString( 'sum:restored', $this->drafts( $sink )[0][ Message::VALUE ] );
	}

	public function test_save_restore_round_trip_is_lossless(): void {
		$a = new Digest_Builder_Demo_Node();
		$m = $this->summary( 'a' );
		$a->fill( $m );
		// Model the real transport: the snapshot crosses a JSON boundary in the offsetlog.
		$transported = \json_decode( (string) \json_encode( $a->save_state() ), true );
		$b           = new Digest_Builder_Demo_Node();
		$b->restore_state( $transported );
		$this->assertEquals( $a->save_state(), $b->save_state() );
	}

	public function test_restore_state_ignores_malformed_payload(): void {
		$node = new Digest_Builder_Demo_Node();
		$node->restore_state( [ 'items' => 'not-an-array' ] );
		$this->assertSame( [ 'items' => [] ], $node->save_state() );
	}
}
