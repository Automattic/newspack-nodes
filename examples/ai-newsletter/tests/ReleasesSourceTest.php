<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-releases-source.php';

use Newspack_AI_Newsletter\Releases_Source_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

final class ReleasesSourceTest extends TestCase {
	public function test_tick_emits_canned_items_as_struct_to_sink(): void {
		$sink   = new Capture_Sink_Node();
		$source = new Releases_Source_Node();
		$source->sink( $sink );

		$source->cmd_tick();

		$msgs = $sink->captured;
		$this->assertNotEmpty( $msgs, 'tick should emit at least one item' );
		foreach ( $msgs as $m ) {
			$this->assertSame( Message::TM_STRUCT, $m[ Message::TYPE ] & Message::TM_STRUCT );
			$this->assertSame( 'releases', $m[ Message::VALUE ]['source'] );
			$this->assertArrayHasKey( 'title', $m[ Message::VALUE ] );
			$this->assertArrayHasKey( 'body', $m[ Message::VALUE ] );
		}
	}

	public function test_items_seam_is_overridable(): void {
		$this->assertTrue( method_exists( Releases_Source_Node::class, 'items' ) );
	}
}
