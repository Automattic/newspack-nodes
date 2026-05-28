<?php
/**
 * ServiceCiSchemaCommandsTest: the DRY mechanism — Service_CI_Node derives its
 * dispatch table (commands) from its own node_schema(), so a service CI declares
 * each verb ONCE (in node_schema's verbs[], carrying a `handler` closure) instead
 * of twice (a verb_table + a verbs[] list).
 *
 * A `verbs[]` entry with a `handler` becomes a command; a `requests[]` entry
 * (answered by the node's own fill(), never CI-dispatched) contributes NO command.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Tiny concrete Service_CI_Node fixture: one verb with a handler, one request
 * without. Exercises the base ctor's schema→commands derivation.
 */
class Schema_Driven_CI_Node extends Service_CI_Node {

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Fixture CI: proves commands() is derived from node_schema().',
			'arguments'        => [],
			'commands'       => [
				[
					'name'        => 'greet',
					'description' => 'Return a fixed greeting.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => 'hello from greet',
				],
			],
			'requests'    => [
				[
					'name'        => 'status',
					'description' => 'Answered by fill(), not CI-dispatched — contributes no command.',
				],
			],
		];
	}
}

/**
 * Sibling fixture exercising malformed verbs: a well-formed verb (installs),
 * a named verb with NO callable handler (skipped + warned), and a verb with an
 * empty-string name (skipped, never keyed by '').
 */
class Malformed_Verbs_CI_Node extends Service_CI_Node {

	public static function node_schema(): array {
		return [
			'category'    => 'Service',
			'description' => 'Fixture CI: malformed verbs are skipped, well-formed ones install.',
			'arguments'        => [],
			'commands'       => [
				[
					'name'        => 'good',
					'description' => 'Well-formed verb with a callable handler.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => 'good result',
				],
				[
					// Named verb, but NO handler key at all → not dispatchable.
					'name'        => 'handlerless',
					'description' => 'Declared in the catalog but carries no handler.',
					'args'        => [],
				],
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

	protected function tearDown(): void {
		VerbHarness::reset();
		parent::tearDown();
	}

	public function test_verb_handler_from_schema_is_dispatchable(): void {
		$result = VerbHarness::fire( new Schema_Driven_CI_Node(), 'fixture', 'greet' );

		$this->assertSame( 'hello from greet', $result );
	}

	public function test_verb_handler_is_installed_in_commands_table(): void {
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

	public function test_default_help_verb_is_still_injected(): void {
		// Command_Interpreter_Node::commands() auto-injects `help` when absent;
		// deriving the table from node_schema() must preserve that base behavior.
		$commands = ( new Schema_Driven_CI_Node() )->commands();

		$this->assertArrayHasKey( 'help', $commands );
	}

	public function test_named_verb_without_callable_handler_is_skipped(): void {
		Core::set_stderr_handler( static function () { /* swallow */ } );

		$commands = ( new Malformed_Verbs_CI_Node() )->commands();

		$this->assertArrayNotHasKey(
			'handlerless',
			$commands,
			'a named verb with no callable handler must not be installed (would dispatch to nothing)'
		);
	}

	public function test_named_verb_without_callable_handler_warns(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );

		( new Malformed_Verbs_CI_Node() )->commands();

		$this->assertStringContainsString( 'handlerless', $buf, 'the warning must name the offending verb' );
		$this->assertStringContainsString( Malformed_Verbs_CI_Node::class, $buf, 'the warning must name the concrete class' );
	}

	public function test_empty_name_verb_is_skipped(): void {
		Core::set_stderr_handler( static function () { /* swallow */ } );

		$commands = ( new Malformed_Verbs_CI_Node() )->commands();

		$this->assertArrayNotHasKey(
			'',
			$commands,
			'an empty-string verb name must never be keyed into the dispatch table'
		);
	}

	public function test_well_formed_verb_still_installs_alongside_malformed_ones(): void {
		Core::set_stderr_handler( static function () { /* swallow */ } );

		$commands = ( new Malformed_Verbs_CI_Node() )->commands();

		$this->assertArrayHasKey( 'good', $commands );
		$this->assertIsCallable( $commands['good'] );
	}

	public function test_well_formed_verb_dispatches_despite_malformed_siblings(): void {
		Core::set_stderr_handler( static function () { /* swallow */ } );

		$result = VerbHarness::fire( new Malformed_Verbs_CI_Node(), 'malformed', 'good' );

		$this->assertSame( 'good result', $result );
	}
}
