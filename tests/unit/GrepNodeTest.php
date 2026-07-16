<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Grep_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Grep_Node::class )]
class GrepNodeTest extends TestCase {

	public function test_forwards_matching_value_and_drops_non_matching(): void {
		// Ported from Tachikoma's Grep.pm: fill() forwards a message whose VALUE
		// matches the regex to the sink; a miss is dropped (not forwarded).
		$g = new Grep_Node();
		$g->arguments( [ 'ERROR' ] );
		$capture = new Capture_Sink_Node();
		$g->sink( $capture );

		$hit = $this->bytestream( 'db ERROR: timeout' );
		$g->fill( $hit );
		$miss = $this->bytestream( 'all good here' );
		$g->fill( $miss );

		$this->assertCount( 1, $capture->captured, 'only the matching message is forwarded' );
		$this->assertSame( 'db ERROR: timeout', $capture->captured[0][ Message::VALUE ] );
	}

	/** @return array<int, mixed> */
	private function bytestream( string $value ): array {
		$m                     = Message::new_message();
		$m[ Message::TYPE ]    = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ]   = $value;
		return $m;
	}
}
