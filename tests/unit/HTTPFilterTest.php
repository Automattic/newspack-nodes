<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\HTTP_Filter;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( HTTP_Filter::class )]
class HTTPFilterTest extends TestCase {

	public function test_fill_emits_when_post_peel_to_matches_own_pid(): void {
		$emitted = [];
		$f = new HTTP_Filter( 12345, static function ( array $msg ) use ( &$emitted ): void {
			$emitted[] = $msg;
		} );
		$msg                   = Message::new_message();
		$msg[ Message::TO ]    = '12345';  // Router already peeled `_http`.
		$msg[ Message::VALUE ] = 'reply';
		$f->fill( $msg );
		$this->assertCount( 1, $emitted );
		$this->assertSame( 'reply', $emitted[0][ Message::VALUE ] );
	}

	public function test_fill_drops_when_to_is_for_a_different_session(): void {
		$emitted = [];
		$f = new HTTP_Filter( 12345, static function ( array $msg ) use ( &$emitted ): void {
			$emitted[] = $msg;
		} );
		$msg                = Message::new_message();
		$msg[ Message::TO ] = '99999';  // Some other browser tab's reply.
		$f->fill( $msg );
		$this->assertCount( 0, $emitted );
	}

	public function test_counter_increments_even_when_message_is_dropped(): void {
		$emitted = [];
		$f = new HTTP_Filter( 12345, static function ( array $msg ) use ( &$emitted ): void {
			$emitted[] = $msg;
		} );
		$msg                = Message::new_message();
		$msg[ Message::TO ] = '99999';  // Different session.
		$f->fill( $msg );
		$this->assertCount( 0, $emitted );
		$this->assertSame( 1, $f->counter() );
	}

	public function test_node_schema_is_hidden_with_empty_ctor_and_verbs(): void {
		// HTTP_Filter is bootstrap-instantiated (per-session, per-PID); it
		// must never appear in the `make_node` factory's discoverable
		// category list or expose user-facing verbs.
		$schema = HTTP_Filter::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertSame( [], $schema['ctor'] );
		$this->assertSame( [], $schema['verbs'] );
		$this->assertNotEmpty( $schema['description'] );
	}
}
