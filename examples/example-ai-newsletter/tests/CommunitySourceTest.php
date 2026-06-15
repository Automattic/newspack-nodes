<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-community-source-demo.php';

use Example_AI_Newsletter\Community_Source_Demo_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

final class CommunitySourceTest extends TestCase {
	/** Build a TICK request as the REPL's `request_node community TICK` would mint it. */
	private function tick_request(): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_REQUEST;
		$m[ Message::FROM ]  = '_repl';
		$m[ Message::VALUE ] = 'TICK';
		return $m;
	}

	public function test_tick_request_emits_community_items(): void {
		$sink   = new Capture_Sink_Node();
		$source = new Community_Source_Demo_Node();
		$source->sink( $sink );

		$req = $this->tick_request();
		$source->fill( $req );

		$items = array_values( array_filter(
			$sink->captured,
			static fn ( $m ) => 0 !== ( $m[ Message::TYPE ] & Message::TM_STRUCT )
				&& 0 === ( $m[ Message::TYPE ] & Message::TM_RESPONSE )
		) );
		$this->assertNotEmpty( $items );
		foreach ( $items as $m ) {
			$this->assertSame( 'community', $m[ Message::VALUE ]['source'] );
			$this->assertArrayHasKey( 'title', $m[ Message::VALUE ] );
			$this->assertArrayHasKey( 'body', $m[ Message::VALUE ] );
		}
	}

	public function test_tick_request_replies_with_emitted_count_to_caller(): void {
		$sink   = new Capture_Sink_Node();
		$source = new Community_Source_Demo_Node();
		$source->sink( $sink );

		$req = $this->tick_request();
		$source->fill( $req );

		$replies = array_values( array_filter(
			$sink->captured,
			static fn ( $m ) => 0 !== ( $m[ Message::TYPE ] & Message::TM_RESPONSE )
		) );
		$this->assertCount( 1, $replies, 'exactly one TM_RESPONSE reply' );
		$reply = $replies[0];
		$this->assertSame( Message::TM_STRUCT, $reply[ Message::TYPE ] & Message::TM_STRUCT );
		$this->assertSame( '_repl', $reply[ Message::TO ], 'reply goes to TO=FROM' );
		$this->assertSame( 'TICK', $reply[ Message::VALUE ]['verb'] );
		$this->assertSame( 3, $reply[ Message::VALUE ]['data']['emitted'] );
	}

	public function test_items_seam_is_overridable(): void {
		$this->assertTrue( method_exists( Community_Source_Demo_Node::class, 'items' ) );
	}

	public function test_emitted_message_carries_TO_from_target(): void {
		$sink   = new Capture_Sink_Node();
		$source = new Community_Source_Demo_Node();
		$source->sink( $sink );
		$source->connect_node( 'summarizer' );

		$req = $this->tick_request();
		$source->fill( $req );

		$items = array_values( array_filter(
			$sink->captured,
			static fn ( $m ) => 0 === ( $m[ Message::TYPE ] & Message::TM_RESPONSE )
		) );
		$this->assertNotEmpty( $items );
		foreach ( $items as $m ) {
			$this->assertSame( 'summarizer', $m[ Message::TO ] );
		}
	}
}
