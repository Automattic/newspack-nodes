<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\HTTP_Out;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( HTTP_Out::class )]
class HTTPOutTest extends TestCase {

	public function test_first_fill_sends_status_200_and_echoes_packed_message(): void {
		$headers = [];
		$sink    = new HTTP_Out(
			static function ( int $code ) use ( &$headers ): void {
				$headers[] = $code;
			}
		);

		$m                     = Message::new_message();
		$m[ Message::TYPE ]    = Message::TM_RESPONSE;
		$m[ Message::ID ]      = 'abc';
		$m[ Message::VALUE ]   = 'payload';

		\ob_start();
		$sink->fill( $m );
		$out = \ob_get_clean();

		$this->assertSame( [ 200 ], $headers );
		$this->assertSame( Message::packed( $m ), $out );
		$this->assertTrue( $sink->sent_headers );
	}

	public function test_subsequent_fills_dont_re_send_headers_but_still_echo(): void {
		$headers = [];
		$sink    = new HTTP_Out(
			static function ( int $code ) use ( &$headers ): void {
				$headers[] = $code;
			}
		);

		$a                  = Message::new_message();
		$a[ Message::VALUE ] = 'first';
		$b                  = Message::new_message();
		$b[ Message::VALUE ] = 'second';

		\ob_start();
		$sink->fill( $a );
		$sink->fill( $b );
		$out = \ob_get_clean();

		$this->assertSame( [ 200 ], $headers );
		$this->assertSame( Message::packed( $a ) . Message::packed( $b ), $out );
	}

	public function test_reset_allows_fresh_status_header_on_next_fill(): void {
		$headers = [];
		$sink    = new HTTP_Out(
			static function ( int $code ) use ( &$headers ): void {
				$headers[] = $code;
			}
		);

		\ob_start();
		$first = Message::new_message();
		$sink->fill( $first );
		$sink->reset();
		$second = Message::new_message();
		$sink->fill( $second );
		\ob_get_clean();

		$this->assertSame( [ 200, 200 ], $headers );
		$this->assertTrue( $sink->sent_headers );
	}
}
