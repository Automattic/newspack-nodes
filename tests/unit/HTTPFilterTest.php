<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\HTTP_Filter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( HTTP_Filter_Node::class )]
class HTTPFilterTest extends TestCase {

	public function test_fill_strips_pid_head_and_emits_remainder_as_to(): void {
		// Router peeled `_http`, leaving TO=`_sse:<ssePid>/<reply-node>`. HTTP_Filter
		// matches the head segment against its pid, strips it, and forwards the
		// remainder so the browser receives TO=`_output` (its Dumper).
		$f = new HTTP_Filter_Node( 12345 );
		$f->sink( $sink = new Capture_Sink_Node() );
		$msg                   = Message::new_message();
		$msg[ Message::TO ]    = '_sse:12345/_output';
		$msg[ Message::VALUE ] = 'reply';
		$f->fill( $msg );
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( '_output', $sink->captured[0][ Message::TO ] );
		$this->assertSame( 'reply', $sink->captured[0][ Message::VALUE ] );
	}

	public function test_fill_strips_to_empty_when_pid_has_no_reply_node_suffix(): void {
		$f = new HTTP_Filter_Node( 12345 );
		$f->sink( $sink = new Capture_Sink_Node() );
		$msg                = Message::new_message();
		$msg[ Message::TO ] = '_sse:12345';  // Bare pid, no reply-node — strips to ''.
		$f->fill( $msg );
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( '', $sink->captured[0][ Message::TO ] );
	}

	public function test_fill_drops_when_to_is_for_a_different_session(): void {
		$f = new HTTP_Filter_Node( 12345 );
		$f->sink( $sink = new Capture_Sink_Node() );
		$msg                = Message::new_message();
		$msg[ Message::TO ] = '_sse:99999/_output';  // Some other browser tab's reply.
		$f->fill( $msg );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_counter_increments_even_when_message_is_dropped(): void {
		$f = new HTTP_Filter_Node( 12345 );
		$f->sink( $sink = new Capture_Sink_Node() );
		$msg                = Message::new_message();
		$msg[ Message::TO ] = '_sse:99999/_output';  // Different session.
		$f->fill( $msg );
		$this->assertCount( 0, $sink->captured );
		$this->assertSame( 1, $f->counter() );
	}

	public function test_node_schema_is_hidden_with_empty_ctor_and_verbs(): void {
		// HTTP_Filter is bootstrap-instantiated (per-session, per-PID); it
		// must never appear in the `make_node` factory's discoverable
		// category list or expose user-facing verbs.
		$schema = HTTP_Filter_Node::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertSame( [], $schema['ctor'] );
		$this->assertSame( [], $schema['verbs'] );
		$this->assertNotEmpty( $schema['description'] );
	}
}
