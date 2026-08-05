<?php
/**
 * JSON_To_Struct_Node: decode a TM_BYTESTREAM JSON line back into a TM_STRUCT
 * array VALUE — the inverse of Struct_To_JSON_Node. Non-JSON lines pass through.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Message;
use Newspack_Nodes\JSON_To_Struct_Node;
use Newspack_Nodes\Struct_To_JSON_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( JSON_To_Struct_Node::class )]
class JsonToStructNodeTest extends TestCase {

	public function test_json_bytestream_is_decoded_into_a_tm_struct(): void {
		$node = new JSON_To_Struct_Node();
		$node->sink( $sink = new Capture_Sink_Node() );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = '{"repo":"newspack-nodes","stars":7}';
		$node->fill( $m );

		$out = $sink->captured[0];
		$this->assertSame( Message::TM_STRUCT, $out[ Message::TYPE ], 'a JSON line is re-typed as a struct' );
		$this->assertSame( [ 'repo' => 'newspack-nodes', 'stars' => 7 ], $out[ Message::VALUE ], 'JSON is decoded to an array' );
	}

	public function test_non_json_line_passes_through_as_bytestream(): void {
		$node = new JSON_To_Struct_Node();
		$node->sink( $sink = new Capture_Sink_Node() );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'not json at all';
		$node->fill( $m );

		$out = $sink->captured[0];
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ], 'a non-JSON line stays a bytestream' );
		$this->assertSame( 'not json at all', $out[ Message::VALUE ] );
	}

	public function test_round_trip_preserves_co_existing_type_flags(): void {
		// A TM_STRUCT|TM_RESPONSE reply (Consumer_Node / Job_Worker_Node mint these)
		// must keep TM_RESPONSE through the serialize -> deserialize round-trip; the
		// nodes swap only the STRUCT/BYTESTREAM bit, never clobber the whole TYPE.
		$encode = new Struct_To_JSON_Node();
		$decode = new JSON_To_Struct_Node();
		$encode->sink( $decode );
		$decode->sink( $sink = new Capture_Sink_Node() );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$m[ Message::VALUE ] = [ 'ok' => true ];
		$encode->fill( $m );

		$out = $sink->captured[0];
		$this->assertSame( Message::TM_STRUCT | Message::TM_RESPONSE, $out[ Message::TYPE ], 'co-existing flags survive' );
		$this->assertSame( [ 'ok' => true ], $out[ Message::VALUE ] );
	}

	public function test_valid_json_scalar_is_not_promoted_to_a_struct(): void {
		// json_decode succeeds on "42" -> int, but a scalar is not a struct: stay a bytestream.
		$node = new JSON_To_Struct_Node();
		$node->sink( $sink = new Capture_Sink_Node() );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = '42';
		$node->fill( $m );

		$out = $sink->captured[0];
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ], 'a JSON scalar stays a bytestream' );
		$this->assertSame( '42', $out[ Message::VALUE ] );
	}

	public function test_round_trips_losslessly_with_struct_to_json(): void {
		// Struct_To_JSON → JSON_To_Struct reconstructs the original array exactly.
		$encode = new Struct_To_JSON_Node();
		$decode = new JSON_To_Struct_Node();
		$encode->sink( $decode );
		$decode->sink( $sink = new Capture_Sink_Node() );

		$original            = [ 'a' => 1, 'b' => [ 'c' => 2 ], 'd' => [ 3, 4 ] ];
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = $original;
		$encode->fill( $m );

		$out = $sink->captured[0];
		$this->assertSame( Message::TM_STRUCT, $out[ Message::TYPE ] );
		$this->assertSame( $original, $out[ Message::VALUE ], 'the struct survives the JSON round-trip' );
	}
}
