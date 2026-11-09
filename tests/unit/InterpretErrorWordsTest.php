<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * A command's TM_ERROR reply carries an engine error's own words only to a
 * caller who may run a MANAGE command; a deliberate refusal reads the same to
 * every caller.
 */
#[CoversClass( Command_Interpreter_Node::class )]
final class InterpretErrorWordsTest extends TestCase {

	/** Where the interpreter under test writes its replies. */
	private Capture_Sink_Node $sink;

	protected function tearDown(): void {
		Command_Interpreter_Node::$default_authorize = null;
		parent::tearDown();
	}

	/**
	 * A service CI whose READ commands throw: `huia` an engine TypeError from a
	 * wrongly typed call, `kokako` a deliberate refusal. The authorize policy
	 * installs `$scope` as the command's ceiling, as `Command_Auth` does.
	 *
	 * @param string|null $scope The session scope the command runs under.
	 */
	private function ci_under( ?string $scope ): Command_Interpreter_Node {
		$ci = new class() extends Service_CI_Node {
			public static function node_schema(): array {
				$read = static fn ( string $name, \Closure $handler ): array => [
					'name'        => $name,
					'description' => "{$name} double",
					'capability'  => Capabilities::READ,
					'args'        => [],
					'handler'     => $handler,
				];
				return [
					'category'    => 'Control',
					'description' => 'error-words double',
					'arguments'   => [],
					'commands'    => [
						$read( 'huia', static fn (): string => ( static fn ( int $n ): string => (string) $n )( 'kea-3309' ) ),
						$read( 'kokako', static function (): string {
							throw new \RuntimeException( 'kokako refused: tieke_6620 is not a node' );
						} ),
					],
					'requests'    => [],
				];
			}
		};
		$ci->name( 'saddleback:ci-' . \strtolower( (string) $scope ) );
		$this->sink = new Capture_Sink_Node();
		$ci->sink( $this->sink );
		$ci->authorize = static function () use ( $scope ): bool {
			Capabilities::$session_scope = $scope;
			return true;
		};
		return $ci;
	}

	/**
	 * The reply text the command `$name` answers under `$ci`.
	 *
	 * @param Command_Interpreter_Node $ci   The interpreter.
	 * @param string                   $name The command.
	 * @return array{0:int,1:string} Its TYPE and VALUE.
	 */
	private function reply( Command_Interpreter_Node $ci, string $name ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND;
		$m[ Message::FROM ]  = '_output/7';
		$m[ Message::VALUE ] = [ 'name' => $name, 'arguments' => [] ];
		$ci->fill( $m );
		$reply = \end( $this->sink->captured );
		return [ (int) $reply[ Message::TYPE ], (string) $reply[ Message::VALUE ]['payload'] ];
	}

	public function test_a_manage_session_reads_the_engine_errors_own_words(): void {
		\Newspack_Nodes\Core::$var['topology'] = 'stitchbird-2290';
		[ $type, $text ] = $this->reply( $this->ci_under( Capabilities::MANAGE ), 'huia' );
		$this->assertSame( Message::TM_COMMAND | Message::TM_ERROR, $type );
		$this->assertStringContainsString( 'must be of type int, string given', $text );
		$this->assertStringContainsString( __FILE__, $text, 'today\'s text names the file' );
	}

	public function test_a_read_session_reads_a_fixed_pathless_line(): void {
		$captured        = $this->capture_stderr();
		[ $type, $text ] = $this->reply( $this->ci_under( Capabilities::READ ), 'huia' );
		$this->assertSame( Message::TM_COMMAND | Message::TM_ERROR, $type );
		$this->assertSame( "huia: internal error; the reason is in the server's log\n", $text );
		$lines = self::stderr_lines( $captured, 'huia: internal error: ' );
		$this->assertCount( 1, $lines );
		$this->assertStringContainsString( 'TypeError: ', $lines[0] );
		$this->assertStringContainsString( 'must be of type int, string given', $lines[0] );
		$this->assertStringContainsString( __FILE__ . ':', $lines[0] );
	}

	public function test_a_manage_user_under_a_read_scoped_session_reads_the_fixed_line(): void {
		$GLOBALS['_wp_test_current_user_id']  = 5502;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		[ , $text ] = $this->reply( $this->ci_under( Capabilities::READ ), 'huia' );
		$this->assertSame( "huia: internal error; the reason is in the server's log\n", $text );
	}

	public function test_a_refusal_reads_the_same_to_read_and_manage(): void {
		\Newspack_Nodes\Core::$var['topology'] = 'stitchbird-2290';
		[ $read_type, $read ]     = $this->reply( $this->ci_under( Capabilities::READ ), 'kokako' );
		[ $manage_type, $manage ] = $this->reply( $this->ci_under( Capabilities::MANAGE ), 'kokako' );
		$this->assertSame( "kokako refused: tieke_6620 is not a node\n", $read );
		$this->assertSame( $read, $manage );
		$this->assertSame( Message::TM_COMMAND | Message::TM_ERROR, $read_type );
		$this->assertSame( $read_type, $manage_type );
	}

	public function test_the_scope_is_restored_after_the_reply_is_written(): void {
		Capabilities::$session_scope = Capabilities::TUNE;
		$this->reply( $this->ci_under( Capabilities::READ ), 'huia' );
		$this->assertSame( Capabilities::TUNE, Capabilities::$session_scope );
	}
}
