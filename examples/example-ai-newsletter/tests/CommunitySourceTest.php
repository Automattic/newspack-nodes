<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-community-source.php';

use Newspack_AI_Newsletter\Community_Source_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

final class CommunitySourceTest extends TestCase {
	public function test_tick_emits_community_items(): void {
		$sink   = new Capture_Sink_Node();
		$source = new Community_Source_Node();
		$source->sink( $sink );

		$source->cmd_tick();

		$msgs = $sink->captured;
		$this->assertNotEmpty( $msgs );
		foreach ( $msgs as $m ) {
			$this->assertSame( Message::TM_STRUCT, $m[ Message::TYPE ] & Message::TM_STRUCT );
			$this->assertSame( 'community', $m[ Message::VALUE ]['source'] );
			$this->assertArrayHasKey( 'title', $m[ Message::VALUE ] );
			$this->assertArrayHasKey( 'body', $m[ Message::VALUE ] );
		}
	}

	public function test_items_seam_is_overridable(): void {
		$this->assertTrue( method_exists( Community_Source_Node::class, 'items' ) );
	}

	public function test_emitted_message_carries_TO_from_target(): void {
		$sink   = new Capture_Sink_Node();
		$source = new Community_Source_Node();
		$source->sink( $sink );
		$source->connect_node( 'summarizer' );

		$source->cmd_tick();

		$this->assertNotEmpty( $sink->captured );
		foreach ( $sink->captured as $m ) {
			$this->assertSame( 'summarizer', $m[ Message::TO ] );
		}
	}
}
