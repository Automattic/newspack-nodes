<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversNothing;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Every SSE event the server emits has a reader on both sides of the wire.
 *
 * The emitted set is read off `SSE_Out_Node`'s own `send_sse_event()` call
 * sites, not off its `SAFE_EVENTS` allow-list, so an event added to the emit
 * path with no branch in the PHP `SSE_In_Node` or the browser `SseInNode`
 * fails here instead of being dropped on the floor by whichever reader lacks
 * it. The allow-list is then held to that same set, so a name nothing emits
 * cannot linger in it.
 */
#[CoversNothing]
class SseEventParityTest extends TestCase {

	/** @return list<string> Event names SSE_Out and its subclass pass to send_sse_event(). */
	private static function emitted_events(): array {
		$names = [];
		foreach ( [ 'includes/rest/class-sse-out-node.php', 'includes/rest/class-log-stream-out-node.php' ] as $file ) {
			\preg_match_all( "/send_sse_event\(\s*'([a-z_]+)'/", (string) \file_get_contents( self::plugin_path( $file ) ), $m );
			$names = [ ...$names, ...$m[1] ];
		}
		$names = \array_values( \array_unique( $names ) );
		\sort( $names );
		return $names;
	}

	private static function plugin_path( string $relative ): string {
		return \dirname( __DIR__, 2 ) . '/' . $relative;
	}

	public function test_the_emit_scan_finds_the_data_and_control_events(): void {
		$emitted = self::emitted_events();

		foreach ( [ 'msg', 'connected', 'heartbeat', 'retry', 'disconnect' ] as $known ) {
			$this->assertContains( $known, $emitted, "scan must see '{$known}', or every assertion below is vacuous" );
		}
	}

	public function test_the_php_reader_dispatches_every_emitted_event(): void {
		$reader = (string) \file_get_contents( self::plugin_path( 'includes/class-sse-in-node.php' ) );

		foreach ( self::emitted_events() as $event ) {
			$this->assertStringContainsString( "'{$event}' === \$type", $reader, "SSE_In_Node has no branch for '{$event}'" );
		}
	}

	public function test_the_js_reader_listens_for_every_emitted_event(): void {
		$reader = (string) \file_get_contents( self::plugin_path( 'src/runtime/sse-in-node.js' ) );

		foreach ( self::emitted_events() as $event ) {
			$this->assertStringContainsString( "addEventListener( '{$event}'", $reader, "SseInNode has no listener for '{$event}'" );
		}
	}

	public function test_the_allow_list_names_exactly_what_is_emitted(): void {
		$safe = \array_keys( ( new \ReflectionClassConstant( SSE_Out_Node::class, 'SAFE_EVENTS' ) )->getValue() );
		\sort( $safe );

		$this->assertSame( self::emitted_events(), $safe );
	}
}
