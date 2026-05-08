<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Node::class )]
class NodeTest extends TestCase {
	public function test_name_set_and_get(): void {
		$n = new CaptureSink();
		$n->name( 'alice' );
		$this->assertSame( 'alice', $n->name() );
		$this->assertSame( $n, Core::node( 'alice' ) );
	}

	public function test_rename_updates_registry(): void {
		$n = new CaptureSink();
		$n->name( 'alice' );
		$n->name( 'bob' );
		$this->assertNull( Core::node( 'alice' ) );
		$this->assertSame( $n, Core::node( 'bob' ) );
	}

	public function test_rename_collision_throws(): void {
		$n1 = new CaptureSink();
		$n1->name( 'alice' );
		$n2 = new CaptureSink();
		$this->expectException( \RuntimeException::class );
		$n2->name( 'alice' );
	}

	public function test_sink_set_and_get(): void {
		$src = new CaptureSink();
		$dst = new CaptureSink();
		$src->sink( $dst );
		$this->assertSame( $dst, $src->sink() );
	}

	public function test_target_set_and_get(): void {
		$n = new CaptureSink();
		$n->target( 'next-node' );
		$this->assertSame( 'next-node', $n->target() );
	}

	public function test_fill_increments_counter_before_dispatch(): void {
		$n   = new CaptureSink();
		$msg = Message::new_message();
		$n->fill( $msg );
		$this->assertSame( 1, $n->counter() );
	}

	public function test_default_fill_forwards_to_sink(): void {
		$src = new class extends Node {}; // default fill() forwards
		$dst = new CaptureSink();
		$src->sink( $dst );

		$msg                       = Message::new_message();
		$msg[ Message::VALUE ]     = 'payload';
		$src->fill( $msg );

		$this->assertCount( 1, $dst->captured );
		$this->assertSame( 'payload', $dst->captured[0][ Message::VALUE ] );
	}
}
