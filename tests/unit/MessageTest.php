<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Message;

#[CoversClass( Message::class )]
class MessageTest extends TestCase {
	public function test_field_constants_are_distinct_indices(): void {
		$this->assertSame( 0, Message::TYPE );
		$this->assertSame( 1, Message::TIMESTAMP );
		$this->assertSame( 2, Message::FROM );
		$this->assertSame( 3, Message::TO );
		$this->assertSame( 4, Message::ID );
		$this->assertSame( 5, Message::KEY );
		$this->assertSame( 6, Message::VALUE );
	}

	public function test_last_value_index_constant_matches_value(): void {
		// Per spec line 770: array_slice(0, LAST_VALUE_INDEX + 1) is the canonical
		// way to copy a Message and drop any internal bookkeeping fields appended
		// by callers.
		$this->assertSame( 6, Message::LAST_VALUE_INDEX );
		$this->assertSame( Message::VALUE, Message::LAST_VALUE_INDEX );

		// Demonstrate the array_slice(0, LAST_VALUE_INDEX + 1) copy semantics work.
		$m            = Message::new_message();
		$m['extra']   = 'bookkeeping'; // simulate a caller-appended field
		$copy         = \array_slice( $m, 0, Message::LAST_VALUE_INDEX + 1, true );
		$this->assertCount( 7, $copy );
		$this->assertArrayNotHasKey( 'extra', $copy );
	}

	public function test_type_flags_are_distinct_bits(): void {
		$flags = [
			Message::TM_BYTESTREAM,
			Message::TM_EOF,
			Message::TM_PING,
			Message::TM_COMMAND,
			Message::TM_RESPONSE,
			Message::TM_ERROR,
			Message::TM_INFO,
			Message::TM_PERSIST,
			Message::TM_STORABLE,
			Message::TM_REQUEST,
		];
		$this->assertCount( 10, \array_unique( $flags ), 'Flags must be distinct' );
		foreach ( $flags as $flag ) {
			$this->assertSame( 1, \substr_count( \decbin( $flag ), '1' ), 'Each flag is a single bit' );
		}
	}

	public function test_new_message_returns_seven_element_array(): void {
		$m = Message::new_message();
		$this->assertCount( 7, $m );
		$this->assertSame( 0, $m[ Message::TYPE ] );
		$this->assertIsFloat( $m[ Message::TIMESTAMP ] );
		$this->assertSame( '', $m[ Message::FROM ] );
		$this->assertSame( '', $m[ Message::TO ] );
		$this->assertSame( '', $m[ Message::ID ] );
		$this->assertSame( '', $m[ Message::KEY ] );
		$this->assertSame( '', $m[ Message::VALUE ] );
	}

	public function test_packed_unpacked_round_trip_preserves_all_fields(): void {
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM | Message::TM_PERSIST;
		$m[ Message::FROM ]  = 'producer';
		$m[ Message::TO ]    = 'consumer';
		$m[ Message::ID ]    = '1234567890:0000000001';
		$m[ Message::KEY ]   = '/some/url';
		$m[ Message::VALUE ] = 'hello world';

		$round_tripped = Message::unpacked( Message::packed( $m ) );

		$this->assertSame( $m[ Message::TYPE ],      $round_tripped[ Message::TYPE ] );
		$this->assertSame( $m[ Message::TIMESTAMP ], $round_tripped[ Message::TIMESTAMP ] );
		$this->assertSame( $m[ Message::FROM ],      $round_tripped[ Message::FROM ] );
		$this->assertSame( $m[ Message::TO ],        $round_tripped[ Message::TO ] );
		$this->assertSame( $m[ Message::ID ],        $round_tripped[ Message::ID ] );
		$this->assertSame( $m[ Message::KEY ],       $round_tripped[ Message::KEY ] );
		$this->assertSame( $m[ Message::VALUE ],     $round_tripped[ Message::VALUE ] );
	}

	public function test_packed_uses_named_keys_not_positional(): void {
		$m = Message::new_message();
		$m[ Message::FROM ] = 'alice';
		$packed = Message::packed( $m );
		$decoded = \json_decode( $packed, true );
		$this->assertArrayHasKey( 'from', $decoded );
		$this->assertSame( 'alice', $decoded['from'] );
		$this->assertArrayNotHasKey( '2', $decoded );
	}

	public function test_query_round_trip(): void {
		$node = new class extends \Newspack_Nodes\Node {
			public function fill( array &$message ): void {
				++$this->counter;
				if ( $message[ Message::TYPE ] & Message::TM_REQUEST ) {
					$resp                       = Message::new_message();
					$resp[ Message::TYPE ]      = Message::TM_RESPONSE;
					$resp[ Message::VALUE ]     = 'pong: ' . $message[ Message::VALUE ];
					$this->sink?->fill( $resp );
				}
			}
		};

		$result = Message::query( $node, 'ping' );
		$this->assertSame( 'pong: ping', $result );
	}
}
