<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Core;
use Newspack_Nodes\Failures;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * `Core::caller_message()` — a deliberate refusal's words reach every caller;
 * an engine error's or a driver's reach only a caller who may run a MANAGE
 * command, and everyone else reads a fixed line while stderr keeps the reason.
 */
#[CoversClass( Core::class )]
#[CoversClass( Capabilities::class )]
final class CallerMessageTest extends TestCase {

	/** A worker caller under a read-scoped session: no user, scope READ. */
	private function as_read_session(): void {
		$this->in_a_worker();
		Capabilities::$session_scope = Capabilities::READ;
	}

	/** A worker process, which a loaded topology binds. */
	private function in_a_worker(): void {
		Core::$var['topology'] = 'fernbird-5571';
	}

	/** A TypeError thrown here, so its file and line name this test file. */
	private function type_error(): \TypeError {
		return new \TypeError( 'kakariki_7741(): Argument #1 ($n) must be of type int, string given' );
	}

	public function test_a_refusal_reads_the_same_to_every_caller(): void {
		$refusal = new \RuntimeException( 'usage: takahe_6612 &lt;id&gt;' );
		$this->as_read_session();
		$this->assertSame( 'usage: takahe_6612 <id>', Core::caller_message( $refusal, 'takahe_6612' ) );
		Capabilities::$session_scope = Capabilities::MANAGE;
		$this->assertSame( 'usage: takahe_6612 <id>', Core::caller_message( $refusal, 'takahe_6612' ) );
	}

	public function test_a_refusal_writes_nothing_to_stderr(): void {
		$captured = $this->capture_stderr();
		$this->as_read_session();
		Core::caller_message( new \InvalidArgumentException( 'pukeko_2290 refused' ), 'pukeko_2290' );
		$this->assertSame( [], self::stderr_lines( $captured, 'pukeko_2290' ) );
	}

	public function test_an_engine_error_reads_fixed_and_pathless_below_manage(): void {
		$this->as_read_session();
		$said = Core::caller_message( $this->type_error(), 'kakariki_7741' );
		$this->assertSame( 'kakariki_7741: internal error; the reason is in the server\'s log', $said );
		$this->assertStringNotContainsString( __FILE__, $said );
	}

	public function test_an_engine_error_reads_as_thrown_to_a_manage_session(): void {
		$this->in_a_worker();
		Capabilities::$session_scope = Capabilities::MANAGE;
		$this->assertSame(
			'kakariki_7741(): Argument #1 ($n) must be of type int, string given',
			Core::caller_message( $this->type_error(), 'kakariki_7741' )
		);
	}

	public function test_the_sites_own_authority_reads_an_engine_error_as_thrown(): void {
		$this->in_a_worker();
		$this->assertNull( Capabilities::$session_scope );
		$this->assertStringStartsWith( 'kakariki_7741(): Argument', Core::caller_message( $this->type_error(), 'kakariki_7741' ) );
	}

	public function test_an_anonymous_request_outside_a_worker_reads_the_fixed_line(): void {
		$this->assertNull( Core::bound_topology() );
		$this->assertSame( 'kakariki_7741: internal error; the reason is in the server\'s log', Core::caller_message( $this->type_error(), 'kakariki_7741' ) );
	}

	public function test_a_manage_user_under_a_read_session_reads_the_fixed_line(): void {
		$GLOBALS['_wp_test_current_user_id']  = 4417;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$this->as_read_session();
		$this->assertSame( 'kakariki_7741: internal error; the reason is in the server\'s log', Core::caller_message( $this->type_error(), 'kakariki_7741' ) );
	}

	public function test_a_manage_user_with_no_session_reads_as_thrown(): void {
		$GLOBALS['_wp_test_current_user_id']  = 4417;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$this->assertStringStartsWith( 'kakariki_7741(): Argument', Core::caller_message( $this->type_error(), 'kakariki_7741' ) );
	}

	public function test_a_user_without_manage_reads_the_fixed_line(): void {
		$GLOBALS['_wp_test_current_user_id']  = 4418;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true ];
		$this->assertSame( 'kakariki_7741: internal error; the reason is in the server\'s log', Core::caller_message( $this->type_error(), 'kakariki_7741' ) );
	}

	public function test_stderr_carries_the_class_message_file_and_line(): void {
		$captured = $this->capture_stderr();
		$this->as_read_session();
		$e = $this->type_error();
		Core::caller_message( $e, 'kakariki_7741' );
		$this->assertSame(
			[ 'kakariki_7741: internal error: TypeError: ' . $e->getMessage() . ' (' . __FILE__ . ':' . $e->getLine() . ')' ],
			self::stderr_lines( $captured, 'kakariki_7741' )
		);
	}

	public function test_stderr_writes_one_line_per_command_while_the_window_holds(): void {
		$captured = $this->capture_stderr();
		$this->as_read_session();
		Core::caller_message( $this->type_error(), 'kakariki_7741' );
		Core::caller_message( new \ValueError( 'second kokako_3371' ), 'kakariki_7741' );
		Core::caller_message( new \DivisionByZeroError( 'tui_5530' ), 'tui_5530' );
		$this->assertCount( 1, self::stderr_lines( $captured, 'kakariki_7741: internal error' ) );
		$this->assertCount( 1, self::stderr_lines( $captured, 'tui_5530: internal error' ) );
	}

	public function test_a_driver_exception_is_held_back_like_an_engine_error(): void {
		$this->as_read_session();
		$pdo = new \PDOException( 'SQLSTATE[HY000]: General error: 14 unable to open database file', 14 );
		$this->assertSame( 'ruru_8812: internal error; the reason is in the server\'s log', Core::caller_message( $pdo, 'ruru_8812' ) );
	}

	public function test_a_refusal_wrapping_a_driver_exception_is_held_back(): void {
		$this->as_read_session();
		$pdo     = new \PDOException( 'unable to open database file', 14 );
		$wrapper = new \RuntimeException( 'sqlite backend could not open /srv/kea-1180/stats.sqlite: [14] unable to open database file', 0, $pdo );
		$said    = Core::caller_message( $wrapper, 'ruru_8812' );
		$this->assertSame( 'ruru_8812: internal error; the reason is in the server\'s log', $said );
		$this->assertStringNotContainsString( '/srv/kea-1180', $said );
	}

	public function test_a_refusal_wrapping_an_engine_error_is_held_back(): void {
		$this->as_read_session();
		$wrapper = new \RuntimeException( 'weta_4404: ' . $this->type_error()->getMessage(), 0, $this->type_error() );
		$this->assertSame( 'weta_4404: internal error; the reason is in the server\'s log', Core::caller_message( $wrapper, 'weta_4404' ) );
	}

	public function test_failures_holding_an_engine_error_is_held_back(): void {
		$this->as_read_session();
		$failures = new Failures( [ new \RuntimeException( 'kiwi_9901 refused' ), $this->type_error() ] );
		$this->assertSame( 'kiwi_9901: internal error; the reason is in the server\'s log', Core::caller_message( $failures, 'kiwi_9901' ) );
	}

	public function test_failures_of_refusals_alone_read_as_written(): void {
		$this->as_read_session();
		$failures = new Failures( [ new \RuntimeException( 'kiwi_9901 refused' ), new \RuntimeException( 'moa_0042 refused' ) ] );
		$this->assertSame( '2 failures: kiwi_9901 refused | moa_0042 refused', Core::caller_message( $failures, 'kiwi_9901' ) );
	}

	public function test_caller_messages_keys_each_line_by_what_it_answers(): void {
		$this->as_read_session();
		$this->assertSame(
			[
				'hihi-1101' => 'unknown topology hihi-1101',
				'kaka-2202' => 'kaka-2202: internal error; the reason is in the server\'s log',
			],
			Core::caller_messages( [ 'hihi-1101' => new \RuntimeException( 'unknown topology hihi-1101' ), 'kaka-2202' => $this->type_error() ] )
		);
	}

	public function test_a_logged_in_manage_user_speaks_for_the_operator(): void {
		$GLOBALS['_wp_test_current_user_id']  = 4419;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$this->assertTrue( Core::speaks_for_operator() );
	}

	public function test_a_worker_under_a_manage_session_speaks_for_the_operator(): void {
		$this->in_a_worker();
		Capabilities::$session_scope = Capabilities::MANAGE;
		$this->assertTrue( Core::speaks_for_operator() );
	}

	public function test_a_worker_under_a_read_session_does_not_speak_for_the_operator(): void {
		$this->as_read_session();
		$this->assertFalse( Core::speaks_for_operator() );
	}

	public function test_an_anonymous_request_outside_a_worker_does_not_speak_for_the_operator(): void {
		$this->assertNull( Core::bound_topology() );
		$this->assertFalse( Core::speaks_for_operator() );
	}

	public function test_a_logged_in_user_without_manage_does_not_speak_for_the_operator(): void {
		$GLOBALS['_wp_test_current_user_id']  = 4420;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true ];
		$this->assertFalse( Core::speaks_for_operator() );
	}
}
