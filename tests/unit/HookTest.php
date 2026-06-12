<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Hook_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Hook_Node::class )]
class HookTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions'] = [];
	}

	/**
	 * Tachikoma-parity constructible: no-arg ctor + arguments() setter walks
	 * the node_schema and assigns hook_name / filter (bool).
	 */
	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		$hook = new Hook_Node();
		$hook->arguments( 'newspack_nodes/test_event true' );
		$ref = new \ReflectionClass( $hook );
		$this->assertSame( 'newspack_nodes/test_event', $ref->getProperty( 'hook_name' )->getValue( $hook ) );
		$this->assertTrue( $ref->getProperty( 'filter' )->getValue( $hook ) );
	}

	public function test_arguments_setter_applies_default_filter_false(): void {
		$hook = new Hook_Node();
		$hook->arguments( 'newspack_nodes/test_event' );
		$ref = new \ReflectionClass( $hook );
		$this->assertSame( 'newspack_nodes/test_event', $ref->getProperty( 'hook_name' )->getValue( $hook ) );
		$this->assertFalse( $ref->getProperty( 'filter' )->getValue( $hook ) );
	}

	public function test_action_mode_fires_do_action(): void {
		$received = null;
		// do_action now receives the message VALUE (payload), not the whole envelope.
		\add_action( 'newspack_nodes/test_action', function ( $value ) use ( &$received ) {
			$received = $value;
		} );

		$hook = new Hook_Node();
		$hook->arguments( 'newspack_nodes/test_action' );
		$hook->sink( new Capture_Sink_Node() );
		$msg = Message::new_message();
		$msg[ Message::VALUE ] = 'data';
		$hook->fill( $msg );

		$this->assertSame( 'data', $received );
	}

	public function test_action_mode_forwards_to_sink_unchanged(): void {
		$hook = new Hook_Node();
		$hook->arguments( 'newspack_nodes/test_action' );
		$capture = new Capture_Sink_Node();
		$hook->sink( $capture );

		$msg = Message::new_message();
		$msg[ Message::VALUE ] = 'data';
		$hook->fill( $msg );

		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 'data', $capture->captured[0][ Message::VALUE ] );
	}

	/**
	 * An unconfigured Hook_Node (empty hook_name) must pass the message through
	 * to its sink unchanged and not error — the guard skips the do_action('') /
	 * apply_filters('') dispatch that an empty hook name would otherwise make.
	 */
	public function test_empty_hook_name_forwards_unchanged_without_dispatch(): void {
		$hook    = new Hook_Node(); // no arguments() -> hook_name stays ''.
		$capture = new Capture_Sink_Node();
		$hook->sink( $capture );

		$msg                   = Message::new_message();
		$msg[ Message::VALUE ] = 'untouched';
		$hook->fill( $msg );

		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 'untouched', $capture->captured[0][ Message::VALUE ] );
	}

	public function test_fill_increments_counter_once_per_message(): void {
		$hook = new Hook_Node();
		$hook->arguments( 'newspack_nodes/test_action' );
		$hook->sink( new Capture_Sink_Node() );

		$msg                   = Message::new_message();
		$msg[ Message::VALUE ] = 'data';
		$hook->fill( $msg );

		$this->assertSame( 1, $hook->counter(), 'fill() must count each message once; parent::fill() already increments.' );
	}

	public function test_filter_mode_replaces_value(): void {
		// apply_filters now receives the message VALUE and its return becomes the
		// new VALUE; a scalar (non-list) return marks the message TM_BYTESTREAM.
		\add_filter( 'newspack_nodes/test_filter', static fn( $value ) => 'transformed' );

		$hook = new Hook_Node();
		$hook->arguments( 'newspack_nodes/test_filter true' );
		$capture = new Capture_Sink_Node();
		$hook->sink( $capture );

		$msg = Message::new_message();
		$msg[ Message::VALUE ] = 'orig';
		$hook->fill( $msg );

		$this->assertSame( 'transformed', $capture->captured[0][ Message::VALUE ] );
		$this->assertSame( Message::TM_BYTESTREAM, $capture->captured[0][ Message::TYPE ] );
	}
}
