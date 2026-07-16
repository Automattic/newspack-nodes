<?php
/**
 * Hook_Node filter-mode behavior.
 *
 * In filter mode Hook_Node passes the message VALUE through apply_filters and
 * adopts the return as the new VALUE: a list-array return is structured data
 * (TYPE becomes TM_STRUCT), anything else is treated as a bytestream payload
 * (TYPE becomes TM_BYTESTREAM). The surrounding envelope fields are preserved.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Hook_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

class HookNodeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions'] = [];
	}

	public function test_filter_list_return_is_adopted_as_struct(): void {
		$node = new Hook_Node();
		$node->name( 'hooky' );
		$node->arguments( [ 'eln_hook_list', '1' ] ); // filter mode on.
		$node->sink( $sink = new Capture_Sink_Node() );

		// The filter receives the VALUE ('payload') and returns a list.
		\add_filter( 'eln_hook_list', static fn( $value ) => [ 'a', 'b', 'c' ] );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::FROM ]  = 'from';
		$message[ Message::VALUE ] = 'payload';
		$node->fill( $message );

		// fill() is by-value: the adoption is visible on the forwarded message, not the caller's.
		$out = $sink->captured[0];
		$this->assertSame( [ 'a', 'b', 'c' ], $out[ Message::VALUE ], 'A list return becomes the new VALUE.' );
		$this->assertSame( Message::TM_STRUCT, $out[ Message::TYPE ], 'A list return marks the message TM_STRUCT.' );
		$this->assertSame( 'from', $out[ Message::FROM ], 'Envelope fields are preserved.' );
	}

	public function test_filter_scalar_return_is_adopted_as_bytestream(): void {
		$node = new Hook_Node();
		$node->name( 'hooky' );
		$node->arguments( [ 'eln_hook_scalar', '1' ] );
		$node->sink( $sink = new Capture_Sink_Node() );

		\add_filter( 'eln_hook_scalar', static fn( $value ) => 'transformed' );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::FROM ]  = 'from';
		$message[ Message::VALUE ] = [ 'k' => 'v' ];
		$node->fill( $message );

		$out = $sink->captured[0];
		$this->assertSame( 'transformed', $out[ Message::VALUE ], 'A scalar return becomes the new VALUE.' );
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ], 'A non-list return marks the message TM_BYTESTREAM.' );
	}

	public function test_filter_non_list_array_return_is_bytestream(): void {
		$node = new Hook_Node();
		$node->name( 'hooky' );
		$node->arguments( [ 'eln_hook_assoc', '1' ] );
		$node->sink( $sink = new Capture_Sink_Node() );

		// An associative (non-list) array is not structured-list data.
		\add_filter( 'eln_hook_assoc', static fn( $value ) => [ 'not' => 'a list' ] );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::FROM ]  = 'from';
		$message[ Message::VALUE ] = 'payload';
		$node->fill( $message );

		$out = $sink->captured[0];
		$this->assertSame( [ 'not' => 'a list' ], $out[ Message::VALUE ] );
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ], 'An associative-array return is not a list, so TM_BYTESTREAM.' );
	}
}
