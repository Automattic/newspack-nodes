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
}
