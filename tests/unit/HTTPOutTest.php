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

	public function test_default_send_header_closure_invokes_status_header_when_none_supplied(): void {
		// Constructor null-coalesces to a closure wrapping the real
		// \status_header(). Without a fed seam, we still need to prove
		// that branch executes on first fill — otherwise the production
		// path is uncovered. Bootstrap stubs status_header() to push the
		// code into $GLOBALS['_wp_test_status_headers'] so we can assert
		// the default closure actually called it.
		$GLOBALS['_wp_test_status_headers'] = [];
		$sink                               = new HTTP_Out();

		\ob_start();
		$m = Message::new_message();
		$sink->fill( $m );
		$out = \ob_get_clean();

		$this->assertTrue( $sink->sent_headers );
		$this->assertSame( Message::packed( $m ), $out );
		$this->assertSame( [ 200 ], $GLOBALS['_wp_test_status_headers'] );
	}

	public function test_node_schema_is_hidden_with_empty_ctor_and_verbs(): void {
		// HTTP_Out is bootstrap-instantiated at request scope only —
		// never via `make_node` from a topology. Hidden category +
		// empty ctor/verbs locks that contract.
		$schema = HTTP_Out::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertSame( [], $schema['ctor'] );
		$this->assertSame( [], $schema['verbs'] );
		$this->assertNotEmpty( $schema['description'] );
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
