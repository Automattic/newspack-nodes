<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Echo_Node::class )]
class EchoTest extends TestCase {

	public function test_target_and_TO_compose_via_path_join(): void {
		// `target/$to` mirrors Tachikoma Echo.pm:29 — Echo composes path so
		// callers can use the same node as a re-router for multiple
		// downstream paths.
		$echo = new Echo_Node();
		$echo->target( 'downstream' );
		$sink = new Capture_Sink_Node();
		$echo->sink( $sink );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$message[ Message::TO ]   = 'sub/path';
		$message[ Message::VALUE ] = 'data';
		$echo->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'downstream/sub/path', $sink->captured[0][ Message::TO ] );
	}

	public function test_no_target_no_TO_bounces_to_FROM(): void {
		// Both empty → return-to-sender (Echo.pm:31). Useful for ping/echo
		// styled Nodes that want their input bounced back along the trail.
		$echo = new Echo_Node();
		$sink = new Capture_Sink_Node();
		$echo->sink( $sink );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::FROM ]  = 'sender';
		$message[ Message::TO ]    = '';
		$message[ Message::VALUE ] = 'roundtrip';
		$echo->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'sender', $sink->captured[0][ Message::TO ] );
	}

	public function test_TO_only_passes_through_unchanged(): void {
		// No target set, but TO is non-empty → forward as-is. Lets Echo sit
		// inline as a no-op when target isn't configured.
		$echo = new Echo_Node();
		$sink = new Capture_Sink_Node();
		$echo->sink( $sink );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::TO ]    = 'preset';
		$message[ Message::VALUE ] = 'data';
		$echo->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'preset', $sink->captured[0][ Message::TO ] );
	}

	public function test_target_only_no_TO_does_not_bounce_to_FROM(): void {
		// Target set + empty TO: Echo doesn't compose (TO is empty) and
		// doesn't bounce (target is non-empty). Falls through to Node's
		// parent fill, which defaults empty TO to target — so the message
		// routes to the target rather than back to FROM.
		$echo = new Echo_Node();
		$echo->target( 'somewhere' );
		$sink = new Capture_Sink_Node();
		$echo->sink( $sink );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::FROM ]  = 'sender';
		$message[ Message::TO ]    = '';
		$message[ Message::VALUE ] = 'data';
		$echo->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'somewhere', $sink->captured[0][ Message::TO ] );
		// Specifically NOT 'sender' — bounce only fires when target is empty too.
	}

	public function test_TM_ERROR_with_empty_TO_is_dropped(): void {
		// Echo.pm:28 — error with no TO would bounce to a producer that
		// isn't expecting the error trail. Drop instead.
		$echo = new Echo_Node();
		$sink = new Capture_Sink_Node();
		$echo->sink( $sink );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_ERROR;
		$message[ Message::FROM ]  = 'producer';
		$message[ Message::TO ]    = '';
		$message[ Message::VALUE ] = 'oops';
		$echo->fill( $message );

		$this->assertCount( 0, $sink->captured );
	}

	public function test_TM_ERROR_with_TO_passes_through(): void {
		// Error WITH a TO is still routed (e.g. an explicit error response
		// addressed at a known handler).
		$echo = new Echo_Node();
		$sink = new Capture_Sink_Node();
		$echo->sink( $sink );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_ERROR;
		$message[ Message::TO ]    = 'error-handler';
		$message[ Message::VALUE ] = 'oops';
		$echo->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'error-handler', $sink->captured[0][ Message::TO ] );
	}
}
