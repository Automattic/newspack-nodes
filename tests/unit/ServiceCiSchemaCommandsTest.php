<?php
/**
 * ServiceCiSchemaCommandsTest: the DRY mechanism — Service_CI_Node derives its
 * dispatch table (commands) from its own node_schema(), so a service interpreter declares
 * each command ONCE (in node_schema's commands[], carrying a `handler` closure) instead
 * of twice (a command_table + a commands[] list).
 *
 * A `commands[]` entry with a `handler` becomes a command; a `requests[]` entry
 * (answered by the node's own fill(), never interpreter-dispatched) contributes NO command.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tests\Helpers\CommandHarness;
use Newspack_Nodes\Tests\TestCase;

/**
 * Tiny concrete Service_CI_Node fixture: one command with a handler, one request
 * without. Exercises the base ctor's schema→commands derivation.
 */
class Schema_Driven_CI_Node extends Service_CI_Node {

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Fixture interpreter: proves commands() is derived from node_schema().',
			'arguments'        => [],
			'commands'       => [
				[
					'name'        => 'greet',
					'description' => 'Return a fixed greeting.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string => 'hello from greet',
				],
			],
			'requests'    => [
				[
					'name'        => 'status',
					'description' => 'Answered by fill(), not interpreter-dispatched — contributes no command.',
				],
			],
		];
	}
}

/**
 * Sibling fixture exercising malformed commands: a well-formed command (installs),
 * a named command with NO callable handler (skipped + warned), and a command with an
 * empty-string name (skipped, never keyed by '').
 */
class Malformed_Commands_CI_Node extends Service_CI_Node {

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Fixture interpreter: malformed commands are skipped, well-formed ones install.',
			'arguments'        => [],
			'commands'       => [
				[
					'name'        => 'good',
					'description' => 'Well-formed command with a callable handler.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string => 'good result',
				],
				[
					// Named command, but NO handler key at all → not dispatchable.
					'name'        => 'handlerless',
					'description' => 'Declared in the catalog but carries no handler.',
					'args'        => [],
				],
				// Not an array at all → carries no name, so it is not a command.
				'stray-scalar-4417',
				[
					// Empty-string name → never keyed, never dispatchable.
					'name'        => '',
					'description' => 'Malformed: empty name.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => 'unreachable',
				],
			],
		];
	}
}

#[CoversClass( Service_CI_Node::class )]
class ServiceCiSchemaCommandsTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// Service_CI commands are gated by default; grant the cap so the
		// dispatch-mechanism assertions exercise the handler, not the gate.
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		CommandHarness::reset();
		parent::tearDown();
	}

	public function test_command_handler_from_schema_is_dispatchable(): void {
		$result = CommandHarness::fire( new Schema_Driven_CI_Node(), 'fixture', 'greet' );

		$this->assertSame( "hello from greet\n", $result );
	}

	public function test_command_handler_is_installed_in_commands_table(): void {
		$commands = ( new Schema_Driven_CI_Node() )->commands();

		$this->assertArrayHasKey( 'greet', $commands );
		$this->assertIsCallable( $commands['greet'] );
	}

	public function test_request_entry_contributes_no_command(): void {
		$commands = ( new Schema_Driven_CI_Node() )->commands();

		$this->assertArrayNotHasKey(
			'status',
			$commands,
			'requests[] entries are answered by fill(), not dispatched — must not appear in commands()'
		);
	}

	public function test_default_help_command_is_still_injected(): void {
		// Command_Interpreter_Node::commands() auto-injects `help` when absent;
		// deriving the table from node_schema() must preserve that base behavior.
		$commands = ( new Schema_Driven_CI_Node() )->commands();

		$this->assertArrayHasKey( 'help', $commands );
	}

	public function test_named_command_without_callable_handler_is_skipped(): void {
		Core::set_stderr_handler( static function () { /* swallow */ } );

		$commands = ( new Malformed_Commands_CI_Node() )->commands();

		$this->assertArrayNotHasKey(
			'handlerless',
			$commands,
			'a named command with no callable handler must not be installed (would dispatch to nothing)'
		);
	}

	public function test_named_command_without_callable_handler_warns(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );

		( new Malformed_Commands_CI_Node() )->commands();

		$this->assertStringContainsString( 'handlerless', $buf, 'the warning must name the offending command' );
		$this->assertStringContainsString( Malformed_Commands_CI_Node::class, $buf, 'the warning must name the concrete class' );
	}

	public function test_empty_name_command_is_skipped(): void {
		Core::set_stderr_handler( static function () { /* swallow */ } );

		$commands = ( new Malformed_Commands_CI_Node() )->commands();

		$this->assertArrayNotHasKey(
			'',
			$commands,
			'an empty-string verb name must never be keyed into the dispatch table'
		);
	}

	/** The one index keys every named entry and drops what carries no name. */
	public function test_declared_commands_keys_named_entries_and_drops_the_rest(): void {
		$this->assertSame( [ 'good', 'handlerless' ], \array_keys( Service_CI_Node::declared_commands( Malformed_Commands_CI_Node::class ) ) );
		$this->assertSame( [ 'status' ], \array_keys( Service_CI_Node::declared_commands( Schema_Driven_CI_Node::class, 'requests' ) ) );
	}

	public function test_well_formed_command_still_installs_alongside_malformed_ones(): void {
		Core::set_stderr_handler( static function () { /* swallow */ } );

		$commands = ( new Malformed_Commands_CI_Node() )->commands();

		$this->assertArrayHasKey( 'good', $commands );
		$this->assertIsCallable( $commands['good'] );
	}

	public function test_well_formed_command_dispatches_despite_malformed_siblings(): void {
		Core::set_stderr_handler( static function () { /* swallow */ } );

		$result = CommandHarness::fire( new Malformed_Commands_CI_Node(), 'malformed', 'good' );

		$this->assertSame( "good result\n", $result );
	}
}
