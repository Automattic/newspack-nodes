<?php
/**
 * Struct_To_JSON_Node: serialize a TM_STRUCT (array VALUE) into a TM_BYTESTREAM
 * JSON string so a Log/terminal downstream can write it; pass everything else through.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Message;
use Newspack_Nodes\Struct_To_JSON_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Struct_To_JSON_Node::class )]
class StructToJsonNodeTest extends TestCase {

	public function test_tm_struct_array_value_is_json_encoded_into_a_bytestream(): void {
		$node = new Struct_To_JSON_Node();
		$node->sink( $sink = new Capture_Sink_Node() );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = [ 'repo' => 'newspack-nodes', 'stars' => 7 ];
		$node->fill( $m );

		$out = $sink->captured[0];
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ], 'struct is re-typed as a bytestream' );
		$this->assertSame( "{\"repo\":\"newspack-nodes\",\"stars\":7}\n", $out[ Message::VALUE ], 'array VALUE is json-encoded' );
	}

	public function test_struct_with_string_value_is_forwarded_as_a_bytestream_verbatim(): void {
		// A TM_STRUCT whose VALUE is already a string (not the array contract, but
		// possible) is not double-encoded — it's re-typed as a bytestream as-is.
		$node = new Struct_To_JSON_Node();
		$node->sink( $sink = new Capture_Sink_Node() );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = 'already a string';
		$node->fill( $m );

		$out = $sink->captured[0];
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ] );
		$this->assertSame( "already a string\n", $out[ Message::VALUE ], 'a string VALUE is not JSON-quoted' );
	}

	public function test_non_struct_message_passes_through_unchanged(): void {
		$node = new Struct_To_JSON_Node();
		$node->sink( $sink = new Capture_Sink_Node() );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'already a line';
		$node->fill( $m );

		$out = $sink->captured[0];
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ] );
		$this->assertSame( 'already a line', $out[ Message::VALUE ], 'non-struct VALUE is untouched' );
	}
}
