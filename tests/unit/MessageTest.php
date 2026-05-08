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
}
