<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Hook;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Hook::class )]
class HookTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions'] = [];
	}

	public function test_action_mode_fires_do_action(): void {
		$received = null;
		\add_action( 'newspack_nodes/test_action', function ( $msg ) use ( &$received ) {
			$received = $msg;
		} );

		$hook = new Hook( 'newspack_nodes/test_action' );
		$msg = Message::new_message();
		$msg[ Message::VALUE ] = 'data';
		$hook->fill( $msg );

		$this->assertNotNull( $received );
		$this->assertSame( 'data', $received[ Message::VALUE ] );
	}

	public function test_action_mode_forwards_to_sink_unchanged(): void {
		$hook = new Hook( 'newspack_nodes/test_action' );
		$capture = new CaptureSink();
		$hook->sink( $capture );

		$msg = Message::new_message();
		$msg[ Message::VALUE ] = 'data';
		$hook->fill( $msg );

		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 'data', $capture->captured[0][ Message::VALUE ] );
	}

	public function test_filter_mode_replaces_value(): void {
		\add_filter( 'newspack_nodes/test_filter', function ( array $msg ) {
			$msg[ Message::VALUE ] = 'transformed';
			return $msg;
		} );

		$hook = new Hook( 'newspack_nodes/test_filter', filter: true );
		$capture = new CaptureSink();
		$hook->sink( $capture );

		$msg = Message::new_message();
		$msg[ Message::VALUE ] = 'orig';
		$hook->fill( $msg );

		$this->assertSame( 'transformed', $capture->captured[0][ Message::VALUE ] );
	}
}
