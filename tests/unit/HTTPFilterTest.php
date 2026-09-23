<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\HTTP_Filter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( HTTP_Filter_Node::class )]
class HTTPFilterTest extends TestCase {

	private const HANDLE = '5e55104cafe0f00d5e55104cafe0f00d';

	public function test_fill_strips_session_head_and_emits_remainder_as_to(): void {
		// Router peeled `_output`, leaving TO=`_sse:<handle>/<reply-node>`. The
		// filter matches the head against its session, strips it, and forwards
		// the remainder so the browser receives TO=`_output` (its Dumper).
		$f = new HTTP_Filter_Node( self::HANDLE );
		$f->sink( $sink = new Capture_Sink_Node() );
		$message                   = Message::new_message();
		$message[ Message::TO ]    = '_sse:' . self::HANDLE . '/_output';
		$message[ Message::VALUE ] = 'reply';
		$f->fill( $message );
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( '_output', $sink->captured[0][ Message::TO ] );
		$this->assertSame( 'reply', $sink->captured[0][ Message::VALUE ] );
	}

	public function test_fill_strips_to_empty_when_the_head_has_no_reply_node_suffix(): void {
		$f = new HTTP_Filter_Node( self::HANDLE );
		$f->sink( $sink = new Capture_Sink_Node() );
		$message                = Message::new_message();
		$message[ Message::TO ] = '_sse:' . self::HANDLE;
		$f->fill( $message );
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( '', $sink->captured[0][ Message::TO ] );
	}

	public function test_fill_drops_a_reply_addressed_to_another_session(): void {
		$f = new HTTP_Filter_Node( self::HANDLE );
		$f->sink( $sink = new Capture_Sink_Node() );
		$message                = Message::new_message();
		$message[ Message::TO ] = '_sse:0ther0ther0ther0ther0ther0the/_output';
		$f->fill( $message );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_fill_drops_a_reply_addressed_to_a_process_pid(): void {
		$f = new HTTP_Filter_Node( self::HANDLE );
		$f->sink( $sink = new Capture_Sink_Node() );
		$message                = Message::new_message();
		$message[ Message::TO ] = '_sse:' . \getmypid() . '/_output';
		$f->fill( $message );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_a_stream_with_no_session_passes_no_reply(): void {
		$f = new HTTP_Filter_Node( null );
		$f->sink( $sink = new Capture_Sink_Node() );
		foreach ( [ '_sse:', '_sse:/_output', '_sse:' . self::HANDLE . '/_output' ] as $to ) {
			$message                = Message::new_message();
			$message[ Message::TO ] = $to;
			$f->fill( $message );
		}
		$this->assertCount( 0, $sink->captured );
		$this->assertSame( 3, $f->counter() );
	}

	public function test_counter_increments_even_when_message_is_dropped(): void {
		$f = new HTTP_Filter_Node( self::HANDLE );
		$f->sink( $sink = new Capture_Sink_Node() );
		$message                = Message::new_message();
		$message[ Message::TO ] = '_sse:0ther0ther0ther0ther0ther0the/_output';
		$f->fill( $message );
		$this->assertCount( 0, $sink->captured );
		$this->assertSame( 1, $f->counter() );
	}

	public function test_node_schema_is_hidden_with_empty_ctor_and_verbs(): void {
		// HTTP_Filter is built by its stream with the session handle; it
		// must never appear in the `make_node` factory's discoverable
		// category list or expose user-facing verbs.
		$schema = HTTP_Filter_Node::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertSame( [], $schema['arguments'] );
		$this->assertSame( [], $schema['commands'] );
		$this->assertNotEmpty( $schema['description'] );
	}
}
