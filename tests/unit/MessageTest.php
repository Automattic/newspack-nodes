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
			Message::TM_STRUCT,
			Message::TM_REQUEST,
			Message::TM_NOREPLY,
		];
		$this->assertCount( 10, \array_unique( $flags ), 'Flags must be distinct' );
		foreach ( $flags as $flag ) {
			$this->assertSame( 1, \substr_count( \decbin( $flag ), '1' ), 'Each flag is a single bit' );
		}
	}

	public function test_noreply_is_a_distinct_high_bit(): void {
		// Fire-and-forget command flag (Tachikoma TM_NOREPLY): suppresses the
		// interpreter's response so a topology loaded with no console to reply
		// to doesn't bounce NOT_AVAILABLE off an absent `_output`.
		$this->assertSame( 512, Message::TM_NOREPLY );
	}

	public function test_new_message_returns_seven_element_array(): void {
		$m = Message::new_message();
		$this->assertCount( 7, $m );
		$this->assertSame( Message::TM_UNTYPED, $m[ Message::TYPE ] );
		$this->assertIsFloat( $m[ Message::TIMESTAMP ] );
		$this->assertSame( '', $m[ Message::FROM ] );
		$this->assertSame( '', $m[ Message::TO ] );
		$this->assertSame( '', $m[ Message::ID ] );
		$this->assertSame( '', $m[ Message::KEY ] );
		$this->assertSame( '', $m[ Message::VALUE ] );
	}

	public function test_packed_unpacked_round_trip_preserves_all_fields(): void {
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM | Message::TM_INFO;
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

	public function test_packed_is_positional(): void {
		$m = Message::new_message();
		$m[ Message::FROM ] = 'alice';
		$packed = Message::packed( $m );
		$decoded = \json_decode( $packed, true );
		$this->assertTrue( \array_is_list( $decoded ) );
		$this->assertCount( 7, $decoded );
		$this->assertSame( 'alice', $decoded[ Message::FROM ] );
	}

	public function test_unpacked_throws_on_malformed_json(): void {
		$this->expectException( \InvalidArgumentException::class );
		Message::unpacked( 'not valid json' );
	}

	public function test_unpacked_throws_on_too_few_fields(): void {
		$this->expectException( \InvalidArgumentException::class );
		Message::unpacked( '[1,2,3]' );
	}

	public function test_unpacked_throws_on_too_many_fields(): void {
		// Stricter than the former `>= 7`: a trailing field on the wire is now
		// rejected, not silently accepted.
		$this->expectException( \InvalidArgumentException::class );
		Message::unpacked( '[0,0,"","","","","","extra"]' );
	}

	public function test_unpacked_throws_on_associative_array(): void {
		$this->expectException( \InvalidArgumentException::class );
		Message::unpacked( '{"type":1}' );
	}

	public function test_local_is_index_seven_after_value(): void {
		// LOCAL is the appended bookkeeping field — provenance taint, never on the wire.
		$this->assertSame( 7, Message::LOCAL );
		$this->assertSame( Message::LAST_VALUE_INDEX + 1, Message::LOCAL );
	}

	/**
	 * A message that was MINTED but never typed is a different failure from a
	 * naked array with no TYPE at all — the first is a bug in our own code, the
	 * second is garbage. TM_UNTYPED is a free HIGH bit so it matches no gate: an
	 * untyped message is inert, where a -1 sentinel would match every type check
	 * in the system (every bit set) and be treated as a command AND an EOF AND an
	 * error, all at once.
	 */
	public function test_untyped_matches_no_type_gate(): void {
		$type = Message::new_message()[ Message::TYPE ];

		foreach ( [
			Message::TM_BYTESTREAM,
			Message::TM_EOF,
			Message::TM_PING,
			Message::TM_COMMAND,
			Message::TM_STRUCT,
			Message::TM_ERROR,
			Message::TM_INFO,
			Message::TM_REQUEST,
			Message::TM_RESPONSE,
		] as $bit ) {
			$this->assertSame( 0, $type & $bit, 'an untyped message is inert' );
		}
	}

	public function test_new_message_has_no_local_field(): void {
		// Absence of LOCAL is the default-untrusted state; only a Shell sets it.
		$m = Message::new_message();
		$this->assertArrayNotHasKey( Message::LOCAL, $m );
	}

	public function test_packed_strips_local_field(): void {
		// The wire only ever carries the canonical 7 fields; LOCAL is stripped at
		// the serialization boundary so it can't cross a process.
		$m                    = Message::new_message();
		$m[ Message::TYPE ]   = Message::TM_COMMAND;
		$m[ Message::LOCAL ]  = true;
		$decoded = \json_decode( Message::packed( $m ), true );
		$this->assertCount( 7, $decoded );
		$this->assertArrayNotHasKey( Message::LOCAL, $decoded );
	}

	/**
	 * packed() returns string, never false. An unencodable VALUE (invalid UTF-8)
	 * makes wp_json_encode() return false; packed() must coerce that to '' and
	 * never error or leak the false out of its string return contract.
	 */
	public function test_packed_returns_empty_string_for_unencodable_value(): void {
		$m                     = Message::new_message();
		$m[ Message::VALUE ]   = "\xB1\x31"; // invalid UTF-8 byte sequence; json_encode -> false.
		$packed                = Message::packed( $m );
		$this->assertSame( '', $packed );
	}

	public function test_split_first_splits_on_first_slash(): void {
		// Single source of truth for taking the leading path segment (Router
		// dispatch + HTTP_Filter pid gate). Only the first slash splits.
		$this->assertSame( [ 'a', 'b/c' ], Message::split_first( 'a/b/c' ) );
		$this->assertSame( [ 'a', '' ], Message::split_first( 'a' ) );
		$this->assertSame( [ '', '' ], Message::split_first( '' ) );
		$this->assertSame( [ 'a', '' ], Message::split_first( 'a/' ) );
		$this->assertSame( [ '12345', '_output' ], Message::split_first( '12345/_output' ) );
	}

}
