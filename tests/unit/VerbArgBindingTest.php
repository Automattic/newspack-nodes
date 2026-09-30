<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * `dispatch()` binds a schema-declared verb's tokens against its `args` before
 * the handler runs, for a service CI and a `:config` interpreter alike, and
 * hands the handler the bound values by name.
 */
#[CoversClass( Command_Interpreter_Node::class )]
#[CoversClass( Command_Args::class )]
class VerbArgBindingTest extends TestCase {

	/** @var array<int,mixed> What the last handler received. */
	private static array $received = [];

	protected function tearDown(): void {
		self::$received = [];
		unset( $GLOBALS['_wp_test_current_user_can'] );
		Core::reset();
		parent::tearDown();
	}

	/**
	 * A `:config` interpreter whose patron declares `graft <node> [<depth>]`
	 * and `prune` with no `args` key at all.
	 */
	private function config_interpreter(): Command_Interpreter_Node {
		$patron = new class() extends Node {
			public static function node_schema(): array {
				return [
					'commands' => [
						[
							'name' => 'graft',
							'args' => [
								[ 'name' => 'node', 'type' => 'node_name', 'required' => true ],
								[ 'name' => 'depth', 'type' => 'int', 'default' => 4 ],
							],
						],
						[ 'name' => 'prune' ],
					],
				] + parent::node_schema();
			}
		};
		$record = static function ( Command_Interpreter_Node $ci, array $args ): string {
			self::$received = $args;
			return 'ok';
		};
		$ci     = new Command_Interpreter_Node();
		$ci->patron( $patron );
		$ci->name( 'rata:config' );
		$ci->commands( [ 'graft' => $record, 'prune' => $record ] );
		return $ci;
	}

	public function test_a_config_verb_receives_its_bound_values_by_name(): void {
		$this->config_interpreter()->dispatch( 'graft', [ '--depth=9', 'kowhai-3317' ] );

		$this->assertSame( [ 'node' => 'kowhai-3317', 'depth' => 9 ], self::$received );
	}

	public function test_a_verb_declaring_no_args_receives_its_raw_tokens(): void {
		$this->config_interpreter()->dispatch( 'prune', [ 'totara-3317', '--deep' ] );

		$this->assertSame( [ 'totara-3317', '--deep' ], self::$received );
	}

	public function test_a_refused_binding_never_reaches_the_handler(): void {
		try {
			$this->config_interpreter()->dispatch( 'graft', [ 'kowhai-3317', '--breadth=2' ] );
			$this->fail( 'an unknown option must refuse' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'unknown option --breadth', $e->getMessage() );
		}
		$this->assertSame( [], self::$received );
	}

	/** The refusal is the verb's ordinary TM_ERROR reply, addressed TO=FROM. */
	public function test_a_refused_binding_answers_the_caller_with_a_tm_error(): void {
		$ci   = $this->config_interpreter();
		$sink = new Capture_Sink_Node();
		$ci->sink( $sink );

		$command                    = Message::new_message();
		$command[ Message::TYPE ]   = Message::TM_COMMAND;
		$command[ Message::FROM ]   = 'pohutukawa-3317';
		$command[ Message::VALUE ]  = [ 'name' => 'graft', 'arguments' => [] ];
		$command[ Message::LOCAL ]  = true;
		$ci->fill( $command );

		$reply = $sink->captured[0];
		$this->assertSame( Message::TM_COMMAND | Message::TM_ERROR, $reply[ Message::TYPE ] );
		$this->assertSame( 'pohutukawa-3317', $reply[ Message::TO ] );
		$this->assertSame( "missing required argument: node\n", $reply[ Message::VALUE ]['payload'] );
	}

	public function test_a_service_ci_verb_receives_its_bound_values_by_name(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$ci = new class() extends \Newspack_Nodes\Service_CI_Node {
			public static function node_schema(): array {
				return [
					'category'    => 'Service',
					'description' => 'binding double',
					'arguments'   => [],
					'commands'    => [
						[
							'name'       => 'plant',
							'capability' => \Newspack_Nodes\Capabilities::READ,
							'args'       => [
								[ 'name' => 'species', 'type' => 'string', 'required' => true ],
								[ 'name' => 'rows', 'type' => 'string', 'variadic' => true ],
							],
							'handler'    => static fn ( Command_Interpreter_Node $ci, array $args ): array => $args,
						],
					],
				];
			}
		};
		$ci->name( 'mahoe:ci' );

		$this->assertSame(
			[ 'species' => 'kauri-3317', 'rows' => [ 'north', 'south' ] ],
			$ci->dispatch( 'plant', [ 'kauri-3317', 'north', 'south' ] )
		);
	}
}
