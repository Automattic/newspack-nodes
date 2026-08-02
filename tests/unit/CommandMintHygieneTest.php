<?php
/**
 * Every command SOURCE mints with ID and KEY empty — the PHP half of
 * src/runtime/__tests__/commandMintHygiene.test.js.
 *
 * A reply is addressed, not correlated: the minter stamps `FROM = <its own
 * name>`, the server replies `TO = FROM`, and the reply lands on that node for
 * its `fill()` to handle. Stamping an id so a reply can be matched — or
 * pressing KEY into service as a demux discriminator when several verbs batch
 * into one tick — re-implements routing that already happened. "N verbs need
 * telling apart" means one node is doing N jobs; make it N nodes.
 *
 * A reply ECHOING the inbound ID/KEY (Command_Interpreter_Node's response,
 * Consumer's reply, Router's error) is a different thing and is not covered
 * here. Nor is Timer's KEY heartbeat stamp, which is not a command.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

class CommandMintHygieneTest extends TestCase {

	/** Distinct from '' so a minter copying the wrong slot is visible. */
	private const NOT_AN_ID = 'op-1700000000-42';

	/** Distinct from the id too, so a swap between them fails. */
	private const NOT_A_KEY = 'slice-demux';

	/**
	 * @param array<int,mixed> $message The minted command.
	 */
	private function assertUncorrelated( array $message ): void {
		$this->assertTrue(
			(bool) ( $message[ Message::TYPE ] & Message::TM_COMMAND ),
			'expected a TM_COMMAND'
		);
		$this->assertSame( '', $message[ Message::ID ], 'a minted command carries no ID' );
		$this->assertSame( '', $message[ Message::KEY ], 'a minted command carries no KEY' );
	}

	public function test_shell_cmd_mints_without_id_or_key(): void {
		$shell = new Shell_Node();

		$this->assertUncorrelated( $shell->parse( 'cmd _uptime uptime' ) );
	}

	public function test_interpreter_reply_to_re_mint_carries_neither(): void {
		( new Router_Node() )->name( Node_Names::ROUTER );
		$capture     = new Capture_Sink_Node();
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $capture );

		$interpreter->dispatch( 'reply_to', [ 'somewhere', 'uptime' ] );

		$commands = \array_values(
			\array_filter(
				$capture->captured,
				static fn ( array $m ): bool => (bool) ( $m[ Message::TYPE ] & Message::TM_COMMAND )
			)
		);
		$this->assertNotEmpty( $commands, 'reply_to should have minted a command' );
		$this->assertUncorrelated( $commands[0] );
	}

	/**
	 * The guard the assertions above are worth having: each checks a field is
	 * empty, and empty is also the new_message() default — so alone, each could
	 * pass because the minter never touched the slot. This proves the assertion
	 * bites, so a minter that starts stamping one is caught.
	 */
	public function test_the_assertion_fails_on_a_command_carrying_either_field(): void {
		$base                        = Message::new_message();
		$base[ Message::TYPE ]       = Message::TM_COMMAND;

		$with_id                   = $base;
		$with_id[ Message::ID ]    = self::NOT_AN_ID;
		$this->assertNotSame( '', $with_id[ Message::ID ] );

		$with_key                  = $base;
		$with_key[ Message::KEY ]  = self::NOT_A_KEY;
		$this->assertNotSame( '', $with_key[ Message::KEY ] );

		foreach ( [ $with_id, $with_key ] as $bad ) {
			$threw = false;
			try {
				$this->assertUncorrelated( $bad );
			} catch ( \PHPUnit\Framework\AssertionFailedError ) {
				$threw = true;
			}
			$this->assertTrue( $threw, 'assertUncorrelated must reject a correlated command' );
		}
	}
}
