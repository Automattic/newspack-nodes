<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Command_Interpreter_Node::class )]
class CommandInterpreterTest extends TestCase {
	protected function tearDown(): void {
		// $default_authorize is static process state — reset so tests don't bleed.
		Command_Interpreter_Node::$default_authorize = null;
		parent::tearDown();
	}

	/** Build a TM_COMMAND Message (empty TO) for the interpret path. */
	private function command_message( string $name, string $args = '', bool $local = false ): array {
		$m                    = Message::new_message();
		$m[ Message::TYPE ]   = Message::TM_COMMAND;
		$m[ Message::FROM ]   = '_output/1';
		$m[ Message::VALUE ]  = [ 'name' => $name, 'arguments' => $args, 'payload' => '' ];
		if ( $local ) {
			$m[ Message::LOCAL ] = true;
		}
		return $m;
	}

	public function test_reply_to_runs_the_verb_locally_and_routes_its_reply_to_the_path(): void {
		// reply_to <path> <verb> [<args>]: run <verb> HERE, but route its reply to
		// <path> (the inverse of command_node, which runs it AT <path>). This is the
		// primitive that lets a worker drive a remote CI's output to one session,
		// e.g. `cmd _repl reply_to _http/_sse:411/_output ls -als`.
		$ci   = new Command_Interpreter_Node();
		$sink = new Capture_Sink_Node();
		$ci->sink( $sink );
		$msg = $this->command_message( 'reply_to', 'some/target uptime', true );
		$ci->fill( $msg );
		// reply_to itself replies with nothing; the sub-verb's reply rode to <path>.
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'some/target', $sink->captured[0][ Message::TO ] );
		$this->assertSame( 'uptime', $sink->captured[0][ Message::VALUE ]['name'] );
	}

	public function test_reply_to_without_a_command_returns_usage(): void {
		$ci   = new Command_Interpreter_Node();
		$sink = new Capture_Sink_Node();
		$ci->sink( $sink );
		$msg = $this->command_message( 'reply_to', 'some/target', true );
		$ci->fill( $msg );
		$this->assertCount( 1, $sink->captured );
		$this->assertStringContainsString(
			'usage: reply_to',
			(string) $sink->captured[0][ Message::VALUE ]['payload']
		);
	}

	public function test_reply_to_refuses_to_nest(): void {
		// Nesting reply_to would recurse synchronously (interpret → cmd_reply_to →
		// fill → interpret …) with no FROM growth to bound it; refuse it. The test
		// completing at all proves there's no unbounded recursion.
		$ci   = new Command_Interpreter_Node();
		$sink = new Capture_Sink_Node();
		$ci->sink( $sink );
		$msg = $this->command_message( 'reply_to', 'a reply_to a uptime', true );
		$ci->fill( $msg );
		$this->assertCount( 1, $sink->captured );
		$this->assertStringContainsString(
			'reply_to cannot invoke reply_to',
			(string) $sink->captured[0][ Message::VALUE ]['payload']
		);
	}

	public function test_interpret_refuses_command_without_local_provenance(): void {
		$ci   = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$sink = new Capture_Sink_Node();
		$ci->sink( $sink );

		$msg = $this->command_message( 'make_node', 'Capture_Sink ghost' ); // no LOCAL
		$ci->fill( $msg );

		// Verb did NOT run — node never created.
		$this->assertNull( Core::node( 'ghost' ) );
		// An unauthorized error response was emitted.
		$resp = $sink->captured[0] ?? null;
		$this->assertNotNull( $resp );
		$this->assertSame( Message::TM_COMMAND | Message::TM_ERROR, $resp[ Message::TYPE ] );
		$this->assertStringContainsString( 'unauthorized', $resp[ Message::VALUE ]['payload'] );
	}

	public function test_interpret_allows_command_with_local_provenance(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$msg = $this->command_message( 'make_node', 'Capture_Sink real', true ); // LOCAL
		$ci->fill( $msg );

		$this->assertInstanceOf( Capture_Sink_Node::class, Core::node( 'real' ) );
	}

	public function test_instance_authorize_overrides_default_local_check(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->authorize = static fn ( array $m ): bool => true;

		$msg = $this->command_message( 'make_node', 'Capture_Sink trusted' ); // no LOCAL
		$ci->fill( $msg );

		$this->assertInstanceOf( Capture_Sink_Node::class, Core::node( 'trusted' ) );
	}

	public function test_static_default_authorize_can_refuse_even_with_local(): void {
		Command_Interpreter_Node::$default_authorize = static fn ( array $m ): bool => false;
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$msg = $this->command_message( 'make_node', 'Capture_Sink nope', true ); // LOCAL set
		$ci->fill( $msg );
		$this->assertNull( Core::node( 'nope' ) );

		// Instance override beats the static default.
		$ci->authorize = static fn ( array $m ): bool => true;
		$msg2 = $this->command_message( 'make_node', 'Capture_Sink yes' );
		$ci->fill( $msg2 );
		$this->assertInstanceOf( Capture_Sink_Node::class, Core::node( 'yes' ) );
	}

	public function test_dispatch_is_not_gated_for_programmatic_callers(): void {
		// The gate lives in interpret() (message path); direct dispatch() stays open
		// for topology/setup code.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->dispatch( 'make_node', 'Capture_Sink direct' );
		$this->assertInstanceOf( Capture_Sink_Node::class, Core::node( 'direct' ) );
	}

	public function test_make_node_creates_named_node_in_registry(): void {
		// Capture_Sink_Node resolves via the `Newspack_Nodes\Tests\` prefix
		// registered in bootstrap, so `make_node Capture_Sink ...` works.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$node = Core::node( 'alice' );
		$this->assertNotNull( $node );
		$this->assertInstanceOf( Capture_Sink_Node::class, $node );
	}

	public function test_make_node_auto_sinks_new_node_into_command_interpreter(): void {

		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$bob = Core::node( 'bob' );

		$this->assertSame( $ci, $bob->sink() );
	}

	public function test_make_node_returns_ok_string(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$result = $ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$this->assertSame( 'ok', $result );
	}

	public function test_make_node_sets_arguments_from_trailing_tokens(): void {
		// arguments() is set IN make_node (from the trailing tokens), not
		// downstream in the node ctor — so every node, uniformly, round-trips
		// through dump_config.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice some args here' );

		$this->assertSame( 'some args here', Core::node( 'alice' )->arguments() );
	}

	public function test_make_node_sets_empty_arguments_with_no_trailing_tokens(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$this->assertSame( '', Core::node( 'alice' )->arguments() );
	}

	public function test_make_node_resolves_the_base_Node_class(): void {
		// The base Node has no `_Node` suffix, so `make_node Node` resolves it
		// directly (under any registered namespace). Its default fill() stamps
		// TO=target and forwards to sink — a bare routing/fan-in primitive (e.g.
		// the SSE-stream process's `_default_route`).
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$result = $ci->dispatch( 'make_node', 'Node router' );

		$this->assertSame( 'ok', $result );
		$node = Core::node( 'router' );
		$this->assertNotNull( $node );
		$this->assertSame( Node::class, \get_class( $node ) );
		$this->assertSame( $ci, $node->sink() );
	}

	public function test_make_node_Node_round_trips_through_shell_name(): void {
		// dump_config emits `make_node <shell_name> <name>`; the base Node's shell
		// name is `Node` (no `_Node` suffix to strip), so the emitted line feeds
		// straight back into make_node.
		$node = new Node();
		$this->assertSame(
			'Node',
			Command_Interpreter_Node::shell_name_for( $node )
		);
	}

	public function test_dispatch_throws_on_unknown_command(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'unknown command: nope' );
		$ci->dispatch( 'nope' );
	}

	public function test_debug_state_no_args_toggles_self(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$this->assertSame( 0, $ci->debug_state() );

		$this->assertSame( '_command_interpreter debug_state: 1', $ci->dispatch( 'debug_state' ) );
		$this->assertSame( 1, $ci->debug_state() );

		$this->assertSame( '_command_interpreter debug_state: 0', $ci->dispatch( 'debug_state' ) );
		$this->assertSame( 0, $ci->debug_state() );
	}

	public function test_debug_state_numeric_arg_sets_self_to_level(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$this->assertSame( '_command_interpreter debug_state: 2', $ci->dispatch( 'debug_state', '2' ) );
		$this->assertSame( 2, $ci->debug_state() );
	}

	public function test_debug_state_with_node_name_toggles_that_node(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$alice = Core::node( 'alice' );
		$this->assertSame( 0, $alice->debug_state() );

		$this->assertSame( 'alice debug_state: 1', $ci->dispatch( 'debug_state', 'alice' ) );
		$this->assertSame( 1, $alice->debug_state() );

		$this->assertSame( 'alice debug_state: 0', $ci->dispatch( 'debug_state', 'alice' ) );
		$this->assertSame( 0, $alice->debug_state() );
	}

	public function test_debug_state_with_node_name_and_level_sets_explicitly(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$this->assertSame( 'alice debug_state: 3', $ci->dispatch( 'debug_state', 'alice 3' ) );
		$this->assertSame( 3, Core::node( 'alice' )->debug_state() );
	}

	public function test_debug_state_unknown_node_returns_error(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$this->assertSame( 'unknown node: nonexistent', $ci->dispatch( 'debug_state', 'nonexistent' ) );
	}

	public function test_make_node_propagates_ci_debug_state_to_children(): void {
		// When the CommandInterpreter has debug_state set, every node it
		// creates via make_node inherits the same level. Lets the operator
		// turn on tracing for an entire topology in one command:
		//   debug_state 1
		//   make_node Foo bar
		//   make_node Foo baz  ← also at level 1
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'debug_state', '1' );
		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$alice = Core::node( 'alice' );
		$this->assertSame( 1, $alice->debug_state(), 'new node inherits CI level' );
	}

	public function test_make_node_does_not_propagate_when_ci_state_is_zero(): void {
		// Inverse: nodes constructed while the CI is at default level 0
		// stay at level 0. No "inherit zero" pun intended — the test guards
		// against accidental writebacks if the propagation logic is sloppy.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$this->assertSame( 0, Core::node( 'alice' )->debug_state() );
	}

	public function test_command_interpreter_forwards_non_commands_to_sink(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
	}

	public function test_command_interpreter_executes_TM_COMMAND(): void {

		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		// VALUE rides as a live PHP structure (no separate json_encode) —
		// it travels through packed()/unpacked() as a nested object.
		$msg[ Message::VALUE ] = [
			'name'      => 'make_node',
			'arguments' => 'Capture_Sink alice',
			'payload'   => '',
		];
		$msg[ Message::LOCAL ] = true; // in-process command — carries the provenance taint
		$ci->fill( $msg );

		$this->assertNotNull( Core::node( 'alice' ) );
	}

	public function test_set_sink_wires_one_node_to_another(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$ci->dispatch( 'set_sink', 'alice bob' );

		$this->assertSame( Core::node( 'bob' ), Core::node( 'alice' )->sink() );
	}

	public function test_connect_node_sets_target(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$ci->dispatch( 'connect_node', 'alice bob' );

		$this->assertSame( 'bob', Core::node( 'alice' )->target() );
	}

	public function test_disconnect_node_clears_target(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$ci->dispatch( 'connect_node', 'alice bob' );
		$ci->dispatch( 'disconnect_node', 'alice' );

		$this->assertSame( '', Core::node( 'alice' )->target() );
	}

	public function test_remove_node_removes_single_node(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$this->assertNotNull( Core::node( 'alice' ) );

		$out = $ci->dispatch( 'remove_node', 'alice' );
		$this->assertStringContainsString( 'removed alice', $out );
		$this->assertNull( Core::node( 'alice' ) );
	}

	public function test_remove_node_aliases_remove_and_rm_match(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'remove', 'alice' );
		$this->assertNull( Core::node( 'alice' ) );

		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$ci->dispatch( 'rm', 'bob' );
		$this->assertNull( Core::node( 'bob' ) );
	}

	public function test_remove_node_accepts_multiple_names(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$ci->dispatch( 'make_node', 'Capture_Sink carol' );

		$out = $ci->dispatch( 'remove_node', 'alice bob carol' );

		$this->assertStringContainsString( 'removed alice', $out );
		$this->assertStringContainsString( 'removed bob',   $out );
		$this->assertStringContainsString( 'removed carol', $out );
		$this->assertNull( Core::node( 'alice' ) );
		$this->assertNull( Core::node( 'bob' ) );
		$this->assertNull( Core::node( 'carol' ) );
	}

	public function test_remove_node_glob_matches_anchored_regex(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink worker-0' );
		$ci->dispatch( 'make_node', 'Capture_Sink worker-1' );
		$ci->dispatch( 'make_node', 'Capture_Sink leader' );

		$out = $ci->dispatch( 'remove_node', '-a worker-\\d+' );

		$this->assertStringContainsString( 'removed worker-0', $out );
		$this->assertStringContainsString( 'removed worker-1', $out );
		// `leader` doesn't match the anchored pattern, must remain.
		$this->assertNotNull( Core::node( 'leader' ) );
	}

	public function test_remove_node_glob_no_matches_reports_no_matches(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'remove_node', '-a will-never-match' );
		$this->assertSame( 'no matches', $out );
	}

	public function test_remove_node_unknown_name_reports_error(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'remove_node', 'ghost' );
		$this->assertStringContainsString( "can't find node", $out );
		$this->assertStringContainsString( 'ghost', $out );
	}

	public function test_remove_node_refuses_to_destroy_interpreter(): void {
		// Removing _command_interpreter would crash subsequent dispatch.
		// remove_node must refuse, both via name match and via $node===$self.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'remove_node', '_command_interpreter' );
		$this->assertStringContainsString( 'refusing', $out );
		// The CI is still registered, ready to keep handling commands.
		$this->assertNotNull( Core::node( '_command_interpreter' ) );
	}

	public function test_remove_node_refuses_baseline_scaffolding_by_name(): void {
		// _router and _output are also baseline; even an outsider CI shouldn't
		// be able to delete them via this command.
		$router = new \Newspack_Nodes\Router_Node();
		$router->name( '_router' );

		$ci = new Command_Interpreter_Node();
		$ci->name( 'helper-ci' );

		$out = $ci->dispatch( 'remove_node', '_router' );
		$this->assertStringContainsString( 'refusing to destroy baseline', $out );
		$this->assertNotNull( Core::node( '_router' ) );
	}

	public function test_remove_node_empty_args_returns_usage(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'remove_node' );
		$this->assertStringContainsString( 'usage:', $out );
	}

	public function test_remove_node_a_flag_with_no_pattern_returns_usage(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'remove_node', '-a' );
		$this->assertStringContainsString( 'usage:', $out );
	}

	public function test_help_covers_every_dispatchable_verb(): void {
		// Contract: every entry in $C (CI dispatch table) MUST be resolvable
		// through `help <verb>` — either directly via $H or through the
		// alias→canonical map. A regression that adds a verb without help
		// would land here as a failed assertion telling us which key.
		$ref = new \ReflectionClass( Command_Interpreter_Node::class );

		// Force initialization of $C and $H (init_C is private and lazy).
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->dispatch( 'help' );

		$c_prop = $ref->getProperty( 'C' );
		$c_prop->setAccessible( true );
		$verbs = \array_keys( $c_prop->getValue() );

		foreach ( $verbs as $verb ) {
			$out = $ci->dispatch( 'help', "$verb" );
			$this->assertStringNotContainsString(
				'no such topic',
				$out,
				"verb '$verb' is dispatchable but has no help entry"
			);
		}
	}

	public function test_help_covers_every_shell_builtin(): void {
		// Shell builtins never reach $C (Shell intercepts them before sending),
		// but they're user-typeable so help must still cover them. Mirrors the
		// list in Shell::parse + the prefix-aware verb cases.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$shell_builtins = [
			'cd', 'chdir',
			'tell', 'tell_node',
			'send', 'send_node',
			'send_eof',
			'command', 'cmd', 'command_node',
			'request', 'request_node',
			'ping',
			'pwd',
			'include',
		];
		foreach ( $shell_builtins as $verb ) {
			$out = $ci->dispatch( 'help', "$verb" );
			$this->assertStringNotContainsString(
				'no such topic',
				$out,
				"shell builtin '$verb' is user-typeable but has no help entry"
			);
		}
	}

	public function test_remove_node_calls_node_remove_node_method(): void {
		// Use a Partition (which has a meaningful remove_node override) and
		// confirm the override fires. After remove, the file handles close —
		// the simplest observable side effect is that the node is no longer
		// in the registry.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$tmp = $this->make_temp_dir();
		try {
			$ci->dispatch( 'make_node', "Partition mypart {$tmp} 0" );
			$this->assertInstanceOf( \Newspack_Nodes\Partition_Node::class, Core::node( 'mypart' ) );

			$ci->dispatch( 'remove_node', 'mypart' );
			$this->assertNull( Core::node( 'mypart' ) );
		} finally {
			$this->rmdir_recursive( $tmp );
		}
	}

	public function test_ls_returns_node_table(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );

		$out = $ci->dispatch( 'ls' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'bob', $out );
	}

	public function test_ls_default_mode_shows_only_siblings(): void {
		// Default mode = nodes whose sink IS this CI.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		// alice + bob auto-sink to _command_interpreter via make_node.
		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );

		// Wire bob → alice so bob's sink is no longer the CI.
		$ci->dispatch( 'set_sink', 'bob alice' );

		$out = $ci->dispatch( 'ls' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringNotContainsString( 'bob', $out, 'ls without -a hides nodes whose sink is not this CI' );
	}

	public function test_ls_dash_a_shows_all_nodes(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$ci->dispatch( 'set_sink', 'bob alice' );

		$out = $ci->dispatch( 'ls', '-a' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'bob', $out );
		$this->assertStringContainsString( '_command_interpreter', $out );
	}

	public function test_ls_dash_a_with_glob_filters_by_regex(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink alex' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );

		$out = $ci->dispatch( 'ls', '-a ^al' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'alex', $out );
		$this->assertStringNotContainsString( 'bob', $out );
	}

	public function test_ls_with_node_name_shows_nodes_sinking_into_it(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink hub' );
		$ci->dispatch( 'make_node', 'Capture_Sink leaf1' );
		$ci->dispatch( 'make_node', 'Capture_Sink leaf2' );
		$ci->dispatch( 'set_sink', 'leaf1 hub' );
		$ci->dispatch( 'set_sink', 'leaf2 hub' );

		$out = $ci->dispatch( 'ls', 'hub' );
		$this->assertStringContainsString( 'leaf1', $out );
		$this->assertStringContainsString( 'leaf2', $out );
		$this->assertStringNotContainsString( 'hub' . "\n", "$out\n", 'hub itself is NOT listed (its sink is the CI, not hub)' );
	}

	public function test_ls_with_unknown_name_returns_error(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'ls', 'nonexistent' );
		$this->assertStringContainsString( "can't find node", $out );
	}

	public function test_ls_dash_c_shows_count_column(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$out = $ci->dispatch( 'ls', '-c' );
		$this->assertStringContainsString( 'COUNT', $out );
		$this->assertStringContainsString( 'NAME', $out );
		$this->assertStringContainsString( 'alice', $out );
	}

	public function test_help_no_args_lists_commands(): void {
		// Listing uses canonical names per Tachikoma convention — aliases like
		// `ls` and `dump` are documented in their canonical entry's help text.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'help' );
		$this->assertStringContainsString( 'list_nodes', $out );
		$this->assertStringContainsString( 'help', $out );
		$this->assertStringContainsString( 'make_node', $out );
		$this->assertStringContainsString( 'dump_node', $out );
		$this->assertStringContainsString( 'ping', $out );
	}

	public function test_help_alias_resolves_to_canonical_topic(): void {
		// `help ls` should return list_nodes' help text.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'help', 'dump' );
		$this->assertStringContainsString( 'dump_node', $out );
		$this->assertStringContainsString( 'alias: dump', $out );
	}

	public function test_help_topic_returns_help_text(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'help', 'ls' );
		$this->assertStringContainsString( 'list_nodes', $out );
		$this->assertStringContainsString( '-c show', $out );
	}

	public function test_help_unknown_topic_returns_error(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'help', 'nonsense' );
		$this->assertStringContainsString( 'no such topic', $out );
	}

	/** Build an envelope carrying KEY=completion (the tab-completion flag). */
	private function completion_envelope(): array {
		$m                 = Message::new_message();
		$m[ Message::KEY ] = 'completion';
		return $m;
	}

	public function test_help_completion_returns_bare_sorted_verb_names(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out   = $ci->dispatch( 'help', '', null, $this->completion_envelope() );
		$lines = \explode( "\n", $out );

		$this->assertContains( 'list_nodes', $lines );
		$this->assertContains( 'make_node', $lines );
		$this->assertContains( 'help', $lines );
		// Aliases are typeable too, so completion offers them alongside canonicals.
		$this->assertContains( 'ls', $lines );
		$this->assertContains( 'rm', $lines );
		$this->assertContains( 'make', $lines );
		// No section headers, no per-topic help text.
		$this->assertStringNotContainsString( '###', $out );
		$this->assertStringNotContainsString( 'SERVER COMMANDS', $out );
		$this->assertStringNotContainsString( 'TM_PING', $out );
		// Sorted, newline-separated.
		$sorted = $lines;
		\sort( $sorted );
		$this->assertSame( $sorted, $lines );
	}

	public function test_help_without_completion_key_is_unchanged(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'help' );
		$this->assertStringContainsString( '### SERVER COMMANDS ###', $out );
		$this->assertStringContainsString( '### SHELL BUILTINS ###', $out );
	}

	public function test_custom_command_table_gets_default_help_listing_its_verbs(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( 'svc' );
		// A subclass-style custom table WITHOUT its own help verb.
		$ci->commands(
			[
				'beta'  => static fn (): string => 'b',
				'alpha' => static fn (): string => 'a',
			]
		);

		$out   = $ci->dispatch( 'help' );
		$lines = \explode( "\n", $out );
		// Sorted verb names, including the injected `help` itself.
		$this->assertSame( [ 'alpha', 'beta', 'help' ], $lines );
	}

	public function test_default_help_does_not_override_a_custom_help_verb(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( 'svc' );
		$ci->commands(
			[
				'alpha' => static fn (): string => 'a',
				'help'  => static fn (): string => 'my own help',
			]
		);

		$this->assertSame( 'my own help', $ci->dispatch( 'help' ) );
	}

	public function test_ls_completion_returns_bare_node_names_no_columns(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );

		// -c column flag must be ignored under completion. Completion lists ALL
		// nodes (like `ls -a`), not just siblings, so `cd <tab>` can reach _-nodes.
		$out   = $ci->dispatch( 'ls', '-c', null, $this->completion_envelope() );
		$lines = \explode( "\n", $out );

		$this->assertContains( 'alice', $lines );
		$this->assertContains( 'bob', $lines );
		$this->assertContains( '_command_interpreter', $lines );
		$this->assertStringNotContainsString( 'COUNT', $out );
		$this->assertStringNotContainsString( 'NAME', $out );
	}

	public function test_ls_completion_dash_a_returns_all_bare_names(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$out   = $ci->dispatch( 'ls', '-a', null, $this->completion_envelope() );
		$lines = \explode( "\n", $out );

		$this->assertContains( 'alice', $lines );
		$this->assertContains( '_command_interpreter', $lines );
		$this->assertStringNotContainsString( 'NAME', $out );
	}

	public function test_ls_without_completion_key_is_unchanged(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$out = $ci->dispatch( 'ls', '-c' );
		$this->assertStringContainsString( 'COUNT', $out );
		$this->assertStringContainsString( 'NAME', $out );
	}

	public function test_dump_node_shows_internal_state(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		// dump_node stringifies here (display-only payload): the class name heads
		// the dump, then the pretty snapshot.
		$out = $ci->dispatch( 'dump_node', 'alice' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'Capture_Sink_Node', $out );
		$this->assertStringContainsString( '"name": "alice"', $out );
		$this->assertStringContainsString( '"sink": "_command_interpreter"', $out );
	}

	public function test_dump_alias_works(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$out = $ci->dispatch( 'dump', 'alice' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( '"name": "alice"', $out );
	}

	public function test_dump_node_with_keys_filters_output(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$out = $ci->dispatch( 'dump_node', 'alice name' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'Capture_Sink_Node', $out ); // class header always shown
		$this->assertStringContainsString( '"name": "alice"', $out );
		$this->assertStringNotContainsString( '"sink"', $out, 'unrequested keys are filtered out' );
	}

	public function test_dump_node_class_key_is_not_an_error(): void {
		// `class` heads the dump, so requesting it as a key is a no-op, not a
		// "can't find key" error.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$out = $ci->dispatch( 'dump_node', 'alice class' );
		$this->assertIsString( $out );
		$this->assertStringNotContainsString( "can't find key", $out );
		$this->assertStringContainsString( 'Capture_Sink_Node', $out );
	}

	public function test_dump_node_unknown_node_returns_error(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'dump_node', 'nonexistent' );
		$this->assertStringContainsString( "can't find node", $out );
	}

	public function test_dump_node_unknown_key_returns_error(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$out = $ci->dispatch( 'dump_node', 'alice no_such_key' );
		$this->assertStringContainsString( "can't find key", $out );
	}

	public function test_TM_PING_with_empty_TO_bounces_to_FROM(): void {
		// Mirrors Tachikoma CommandInterpreter.pm:94-96. When CI receives
		// TM_PING with empty TO (i.e., addressed to itself after _router peeled),
		// it sets TO=FROM and forwards via sink so the message walks the
		// breadcrumb trail back to the originator.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_PING;
		$msg[ Message::FROM ]      = '_output/12345';
		$msg[ Message::VALUE ]     = '1234567890.123456';
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$bounced = $downstream->captured[0];
		$this->assertSame( Message::TM_PING, $bounced[ Message::TYPE ] );
		$this->assertSame( '_output/12345', $bounced[ Message::TO ], 'TM_PING bounce sets TO=FROM' );
		$this->assertSame( '1234567890.123456', $bounced[ Message::VALUE ], 'payload preserved' );
	}

	public function test_TM_EOF_with_empty_TO_bounces_to_FROM(): void {
		// TM_EOF with empty TO is a drain marker emitted by `wp nodes cli`
		// when stdin closes — the cli expects the receiving CI to bounce it
		// back so the cli knows all preceding output has been drained from
		// the IPC partitions before exiting. Same TO=FROM pattern as
		// TM_PING.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_EOF;
		$msg[ Message::FROM ] = '_output/12345';
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$bounced = $downstream->captured[0];
		$this->assertSame( Message::TM_EOF, $bounced[ Message::TYPE ] );
		$this->assertSame( '_output/12345', $bounced[ Message::TO ], 'TM_EOF bounce sets TO=FROM' );
	}

	public function test_TM_EOF_with_non_empty_TO_does_not_bounce(): void {
		// TM_EOF in transit toward another node: forward as-is. Only the
		// destination CI (where TO arrives empty after _router peels) bounces.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_EOF;
		$msg[ Message::FROM ] = '_output/12345';
		$msg[ Message::TO ]   = 'somewhere_else';
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$this->assertSame( 'somewhere_else', $downstream->captured[0][ Message::TO ], 'TO preserved on transit' );
	}

	public function test_TM_PING_with_non_empty_TO_does_not_bounce(): void {
		// TM_PING with TO set (e.g., transiting through this CI on the way to
		// somewhere else) just forwards normally — only the destination CI
		// (where TO arrives empty after _router peels) does the bounce.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_PING;
		$msg[ Message::FROM ] = '_output/12345';
		$msg[ Message::TO ]   = 'some_other_node';
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$forwarded = $downstream->captured[0];
		$this->assertSame( 'some_other_node', $forwarded[ Message::TO ], 'TO preserved on transit' );
	}

	public function test_stats_renders_tachikoma_columns(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		// alice is a sibling (sinks into _command_interpreter via make_node).
		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$alice                       = Core::node( 'alice' );
		$msg                         = Message::new_message();
		$msg[ Message::VALUE ]       = 'twelve bytes';
		$alice->fill( $msg );

		$out = $ci->dispatch( 'stats' );

		// Header columns:
		$this->assertStringContainsString( 'NAME',     $out );
		$this->assertStringContainsString( 'COUNT',    $out );
		$this->assertStringContainsString( 'LGST_MSG', $out );
		$this->assertStringContainsString( 'READ',     $out );
		$this->assertStringContainsString( 'WRITTEN',  $out );
		// Per-node row: name + values. lgst_msg tracks packed-Message
		// size (not bare VALUE length); compute against the actual envelope
		// so the assertion survives Message-shape changes.
		$lgst = \strlen( Message::packed( $msg ) );
		$this->assertMatchesRegularExpression(
			"/alice\\s+1\\s+{$lgst}\\s+0\\s+0/",
			$out,
			"alice row should show counter=1, lgst_msg={$lgst}, read=0, written=0"
		);
	}

	public function test_dump_metadata_includes_lgst_msg_and_byte_counters(): void {
		// CaptureSink overrides fill() to track packed-Message size — base
		// Node intentionally doesn't, so we use a tracking subclass here
		// to exercise the dump_metadata field surface.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$alice = new Capture_Sink_Node();
		$alice->name( 'alice' );

		$msg                   = Message::new_message();
		$msg[ Message::VALUE ] = 'twelve bytes';
		$alice->fill( $msg );

		// dump_metadata returns a live PHP structure now — no JSON string to decode.
		$decoded = $ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $decoded );
		$this->assertArrayHasKey( 'alice', $decoded );
		$this->assertSame(
			\strlen( Message::packed( $msg ) ),
			$decoded['alice']['lgst_msg']
		);
		$this->assertSame( 0,  $decoded['alice']['bytes_read'] );
		$this->assertSame( 0,  $decoded['alice']['bytes_written'] );
	}

	public function test_dump_metadata_class_is_the_unqualified_short_name(): void {
		// The `class` field is the shell name (short name minus `_Node`) the GUI
		// renders, never the fully-qualified `Newspack_Nodes\Tests\Capture_Sink_Node`.
		// This pins the contract so the basename computation can't regress to the FQCN.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$alice = new Capture_Sink_Node();
		$alice->name( 'alice' );

		$decoded = $ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $decoded );
		$this->assertArrayHasKey( 'alice', $decoded );
		$this->assertSame( 'Capture_Sink', $decoded['alice']['class'] );
	}

	public function test_dump_metadata_class_is_the_registered_shell_name(): void {
		// The `class` field is the SHELL name the GUI catalog keys on, which
		// differs from the class short-name when they diverge (Echo_Node → 'Echo').
		// The JS Inspector does `catalog.find( c => c.shell_name === node.class )`
		// and `node.class === 'Tee'`, so reporting the short-name 'Echo_Node'
		// would break schema lookup + Tee detection on the canvas.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$node = new Echo_Node();
		$node->name( 'e1' );

		$decoded = $ci->dispatch( 'dump_metadata' );

		$this->assertSame( 'Echo', $decoded['e1']['class'] );
	}

	public function test_uptime_under_one_minute_shows_seconds_only(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + 42;
		$this->assertStringContainsString( 'up 42s', $ci->dispatch( 'uptime' ) );
	}

	public function test_uptime_under_one_minute_pads_single_digit_seconds(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + 7;
		$this->assertStringContainsString( 'up 07s', $ci->dispatch( 'uptime' ) );
	}

	public function test_uptime_under_one_hour_pads_single_digit_seconds(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + ( 4 * 60 ) + 7;
		$this->assertStringContainsString( 'up 4m 07s', $ci->dispatch( 'uptime' ) );
	}

	public function test_uptime_under_one_hour_shows_minutes_and_seconds(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + ( 4 * 60 ) + 12;
		$this->assertStringContainsString( 'up 4m 12s', $ci->dispatch( 'uptime' ) );
	}

	public function test_uptime_under_one_day_pads_single_digit_minutes(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + ( 2 * 3_600 ) + ( 5 * 60 );
		$this->assertStringContainsString( 'up 2h 05m', $ci->dispatch( 'uptime' ) );
	}

	public function test_uptime_under_one_day_shows_hours_and_minutes(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + ( 2 * 3_600 ) + ( 35 * 60 );
		$this->assertStringContainsString( 'up 2h 35m', $ci->dispatch( 'uptime' ) );
	}

	public function test_uptime_over_one_day_shows_days_and_hms(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + ( 3 * 86_400 ) + ( 4 * 3_600 ) + ( 5 * 60 ) + 6;
		$this->assertStringContainsString( 'up 3d 04:05:06', $ci->dispatch( 'uptime' ) );
	}

	public function test_dump_config_round_trips_full_graph(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$ci->dispatch( 'connect_node', 'alice bob' );

		$dump = $ci->dispatch( 'dump_config' );
		$this->assertStringContainsString( 'make_node Capture_Sink alice', $dump );
		$this->assertStringContainsString( 'make_node Capture_Sink bob', $dump );
		$this->assertStringContainsString( 'connect_node alice bob', $dump );
		// alice's sink is _command_interpreter (auto-default) — should NOT be emitted.
		$this->assertStringNotContainsString( 'set_sink alice', $dump );
	}

	// ── A1: instance verb table + patron pointer ─────────────────

	public function test_patron_accessor_round_trips(): void {
		$ci   = new Command_Interpreter_Node();
		$node = new \Newspack_Nodes\Callback_Node( static fn () => null );
		$this->assertNull( $ci->patron() );
		$ci->patron( $node );
		$this->assertSame( $node, $ci->patron() );
	}

	public function test_commands_accessor_replaces_verb_table(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( 'test_ci' );
		$ci->commands(
			[
				'echo_args' => static fn ( Command_Interpreter_Node $self, string $args ) => "got: $args",
			]
		);
		$result = $ci->dispatch( 'echo_args', 'hello world' );
		$this->assertSame( 'got: hello world', $result );
	}

	public function test_default_ci_still_has_default_verbs_after_refactor(): void {
		// Regression: moving $C from class-level static to instance must
		// not break the bare `_command_interpreter`'s built-in verbs.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$result = $ci->dispatch( 'ls' );
		$this->assertStringNotContainsString( 'unknown command', $result );
	}

	public function test_dump_metadata_skips_any_patron_linked_node(): void {
		// Patron data node — visible.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->dispatch( 'make_node', 'Capture_Sink patron_node' );
		$patron = \Newspack_Nodes\Core::node( 'patron_node' );

		// Non-CI plumbing node (e.g. mirrors Partition's Lock helper).
		$helper = new Capture_Sink_Node();
		$helper->patron( $patron );
		$helper->name( 'patron_node:helper' );

		$metadata = $ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $metadata );
		$this->assertArrayHasKey( 'patron_node', $metadata );
		$this->assertArrayNotHasKey(
			'patron_node:helper',
			$metadata,
			'any node with patron() set must be hidden, not just CIs'
		);
	}

	public function test_dump_metadata_skips_patron_linked_sibling_cis(): void {
		// Patron data node — visible to the canvas.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->dispatch( 'make_node', 'Capture_Sink patron_node' );
		$patron = \Newspack_Nodes\Core::node( 'patron_node' );

		// Sibling CI — should be filtered out of dump_metadata.
		$sibling = new Command_Interpreter_Node();
		$sibling->patron( $patron );
		$sibling->name( 'patron_node:config' );

		$metadata = $ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $metadata );
		$this->assertArrayHasKey( 'patron_node', $metadata );
		$this->assertArrayNotHasKey( 'patron_node:config', $metadata );
	}

	// ── Argument validation paths on verb handlers ────────────────

	public function test_make_node_with_too_few_args_returns_usage(): void {
		// `make_node` alone — no type, no name — must return a usage hint
		// rather than throw. Tachikoma CI contract: validation errors fall
		// out as plain strings, only handler exceptions go through the
		// TM_ERROR wrap in interpret().
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'make_node' );
		$this->assertStringContainsString( 'usage: make_node', $out );
	}

	public function test_make_node_with_only_type_returns_usage(): void {
		// `make_node Capture_Sink` (no name) — still under the 2-token bar.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'make_node', 'Capture_Sink' );
		$this->assertStringContainsString( 'usage: make_node', $out );
	}

	public function test_make_node_unknown_class_returns_error(): void {
		// Class shell-name resolves to no registered namespace — the cmd should
		// surface `unknown class: <type>` and NOT auto-create anything.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'make_node', 'NotARegisteredClass alice' );
		$this->assertSame( 'unknown class: NotARegisteredClass', $out );
		$this->assertNull( Core::node( 'alice' ) );
	}

	// ── cmd_set_sink error paths ──────────────────────────────────

	public function test_set_sink_missing_target_returns_usage(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$out = $ci->dispatch( 'set_sink', 'alice' );
		$this->assertStringContainsString( 'usage: set_sink', $out );
	}

	public function test_set_sink_empty_args_returns_usage(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'set_sink' );
		$this->assertStringContainsString( 'usage: set_sink', $out );
	}

	public function test_set_sink_unknown_node_returns_error(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		// alice exists, ghost does not — both src and dst lookup go
		// through Core::node, so either being null yields 'unknown node'.
		$out = $ci->dispatch( 'set_sink', 'alice ghost' );
		$this->assertSame( 'unknown node', $out );

		$out = $ci->dispatch( 'set_sink', 'ghost alice' );
		$this->assertSame( 'unknown node', $out );
	}

	// ── cmd_connect_node error paths + envelope FROM defaulting ──

	public function test_connect_node_empty_args_returns_usage(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'connect_node' );
		$this->assertStringContainsString( 'usage: connect_node', $out );
	}

	public function test_connect_node_unknown_node_returns_error(): void {
		// `connect_node` with a name not in the registry: must surface
		// the not-found message rather than touch any node state.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'connect_node', 'ghost bob' );
		$this->assertStringContainsString( 'unknown node: ghost', $out );
	}

	public function test_connect_node_without_target_and_without_envelope_returns_usage(): void {
		// `connect_node alice` with no envelope FROM — should fall through
		// to the second usage branch (line 325): no target supplied, no
		// FROM to default to, so the verb has nothing to bind alice to.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		// $ci->execute( verb, envelope=[] ) — empty envelope == empty FROM.
		$out = $ci->dispatch( 'connect_node', 'alice' );
		$this->assertStringContainsString( 'usage: connect_node', $out );
	}

	public function test_connect_node_defaults_to_envelope_FROM_when_target_omitted(): void {
		// Tachikoma contract: `connect_node <node>` with no target binds
		// the node back to the cli/SSE session that issued the command
		// (the message's FROM). This is the "tail this node into my
		// session" shortcut.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		// Hand-build the envelope and call execute with it.
		$envelope                       = Message::new_message();
		$envelope[ Message::FROM ]      = '_output/4242';

		$out = $ci->dispatch( 'connect_node', 'alice', null, $envelope  );
		$this->assertSame( 'ok', $out );
		$this->assertSame( '_output/4242', Core::node( 'alice' )->target() );
	}

	// ── cmd_disconnect_node error paths + Tee envelope behavior ──

	public function test_disconnect_node_empty_args_returns_usage(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'disconnect_node' );
		$this->assertStringContainsString( 'usage: disconnect_node', $out );
	}

	public function test_disconnect_node_unknown_node_returns_error(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'disconnect_node', 'ghost' );
		$this->assertStringContainsString( 'unknown node: ghost', $out );
	}

	public function test_disconnect_node_tee_with_empty_target_and_empty_envelope_returns_usage(): void {
		// `disconnect_node <tee>` with no explicit target AND no envelope
		// FROM to default to: hits the second usage branch (line 350).
		// Tees have array target(); we need the array branch to be
		// taken for this guard to fire.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Tee fanout' );
		$tee = Core::node( 'fanout' );
		$this->assertIsArray( $tee->target() );

		$out = $ci->dispatch( 'disconnect_node', 'fanout' );
		$this->assertStringContainsString( 'usage: disconnect_node', $out );
	}

	public function test_disconnect_node_tee_defaults_to_envelope_FROM_when_target_omitted(): void {
		// Mirror of connect_node's default-to-FROM behavior for the
		// symmetric undo path: `disconnect_node <tee>` with no explicit
		// target should peel the issuing FROM out of the Tee's fan-out.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Tee fanout' );

		// First wire two targets — one default, one explicit.
		$envelope                  = Message::new_message();
		$envelope[ Message::FROM ] = '_output/9999';
		$ci->dispatch( 'connect_node', 'fanout', null, $envelope  );
		$ci->dispatch( 'connect_node', 'fanout other_target' );
		$this->assertSame( [ '_output/9999', 'other_target' ], Core::node( 'fanout' )->target() );

		// disconnect with the same envelope — should remove only the FROM.
		$out = $ci->dispatch( 'disconnect_node', 'fanout', null, $envelope  );
		$this->assertSame( 'ok', $out );
		$this->assertSame( [ 'other_target' ], \array_values( Core::node( 'fanout' )->target() ) );
	}

	// ── cmd_pwd ────────────────────────────────────────────────────

	public function test_pwd_renders_cwd_arrow_from(): void {
		// `pwd` reports the cwd token (from $args) and the issuing
		// envelope's FROM in `  <cwd> -> <from>` form.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$envelope                  = Message::new_message();
		$envelope[ Message::FROM ] = '_output/abc';

		$out = $ci->dispatch( 'pwd', '/some/path', null, $envelope  );
		$this->assertSame( ' /some/path -> _output/abc', $out );
	}

	public function test_pwd_empty_cwd_shows_slash(): void {
		// `pwd` with no args defaults to `/` (the root scope marker that
		// the Shell uses when cwd is empty).
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$envelope                  = Message::new_message();
		$envelope[ Message::FROM ] = '_output/abc';

		$out = $ci->dispatch( 'pwd', '', null, $envelope  );
		$this->assertSame( ' / -> _output/abc', $out );
	}

	// ── cmd_log ───────────────────────────────────────────────────

	public function test_log_routes_args_through_core_stderr(): void {
		// `log <message>` emits its args through the Core stderr pipeline
		// (the test handler captures the text). Returns empty string —
		// `interpret()` suppresses response wrapping for that case so the
		// operator's transcript stays quiet.
		$captured = [];
		Core::set_stderr_handler(
			static function ( string $msg ) use ( &$captured ): void {
				$captured[] = $msg;
			}
		);

		try {
			$ci = new Command_Interpreter_Node();
			$ci->name( '_command_interpreter' );

			$out = $ci->dispatch( 'log', 'hello from log verb' );
			$this->assertSame( '', $out, 'log returns empty string — caller suppresses response' );
			$this->assertCount( 1, $captured );
			// log routes through the CI NODE's stderr (per "$this->stderr() when a
			// $this is handy"), so the captured line carries the log_prefix
			// (timestamp + identity) AND the node's log_midfix tag.
			$this->assertMatchesRegularExpression(
				'/^\d{4}-\d\d-\d\d.*\]: _command_interpreter: hello from log verb\n$/',
				$captured[0]
			);
		} finally {
			// Restore the bootstrap default so subsequent tests don't leak.
			Core::reset();
		}
	}

	// ── cmd_dump_node misuses ─────────────────────────────────────

	public function test_dump_node_with_empty_args_says_no_node_specified(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'dump_node' );
		$this->assertSame( 'no node specified', $out );
	}

	// ── cmd_uptime: clock segment ─────────────────────────────────

	public function test_uptime_renders_clock_prefix_in_HHMMSS(): void {
		// The output is `HH:MM:SS  up <elapsed>` — covers the gmdate()
		// clock-segment branch that wasn't asserted on by the existing
		// uptime suite (which only checked the elapsed portion).
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		// 2023-11-14T22:13:20+00:00.
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + 7;

		$out = $ci->dispatch( 'uptime' );
		$this->assertMatchesRegularExpression( '/^\d{2}:\d{2}:\d{2}  up /', $out );
		// Core::$now == 1_700_000_007 → 22:13:27 UTC. Elapsed 7s pads to "07s".
		$this->assertStringContainsString( '22:13:27  up 07s', $out );
	}

	// ── cmd_list_nodes additional column flags ────────────────────

	public function test_ls_dash_s_shows_sink_column(): void {
		// -s flag enables the SINK column in the tabulated output.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );

		$out = $ci->dispatch( 'ls', '-s' );
		$this->assertStringContainsString( 'SINK', $out );
		$this->assertStringContainsString( '_command_interpreter', $out );
	}

	public function test_ls_dash_t_shows_target_column(): void {
		// -t flag enables the TARGET column.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$ci->dispatch( 'connect_node', 'alice bob' );

		$out = $ci->dispatch( 'ls', '-t' );
		$this->assertStringContainsString( 'TARGET', $out );
		$this->assertStringContainsString( '-> bob', $out );
	}

	public function test_ls_dash_l_implies_count_and_target(): void {
		// -l == -ct: count column AND target column rendered together.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$ci->dispatch( 'connect_node', 'alice bob' );

		$out = $ci->dispatch( 'ls', '-l' );
		$this->assertStringContainsString( 'COUNT', $out );
		$this->assertStringContainsString( 'TARGET', $out );
		$this->assertStringContainsString( '-> bob', $out );
	}

	public function test_ls_dash_a_with_glob_no_matches_renders_no_matches_row(): void {
		// `ls -a <glob>` with a regex that doesn't hit any node should
		// surface a `no matches` row in the output. Tabulated output goes
		// through the column-flag path even though no flags were given —
		// the no-matches branch happens regardless.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'ls', '-a never-going-to-match-anything' );
		$this->assertStringContainsString( 'no matches', $out );
	}

	public function test_ls_with_target_column_for_tee_renders_comma_separated(): void {
		// Tee target() returns an array; ls -t implodes with ', '.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Tee fanout' );
		$ci->dispatch( 'connect_node', 'fanout one' );
		$ci->dispatch( 'connect_node', 'fanout two' );

		$out = $ci->dispatch( 'ls', '-t' );
		$this->assertStringContainsString( '-> one, two', $out );
	}

	// ── cmd_stats: -a flag and missing-stats default header ───────

	public function test_stats_dash_a_shows_every_registered_node(): void {
		// `-a` flag short-circuits the sibling filter and lists every
		// node regardless of sink. Forces the `$list_matches` branch
		// in cmd_stats.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );
		$ci->dispatch( 'set_sink', 'bob alice' );  // bob's sink isn't this CI.

		$out = $ci->dispatch( 'stats', '-a' );
		$this->assertStringContainsString( 'NAME', $out );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'bob', $out, '-a includes non-sibling nodes' );
	}

	public function test_stats_dash_a_with_glob_filters_by_regex(): void {
		// Regex glob with `-a`: only nodes whose name matches the glob
		// pattern should appear. Covers the @preg_match branch inside
		// the $list_matches arm.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink alice' );
		$ci->dispatch( 'make_node', 'Capture_Sink alex' );
		$ci->dispatch( 'make_node', 'Capture_Sink bob' );

		$out = $ci->dispatch( 'stats', '-a ^al' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'alex', $out );
		$this->assertStringNotContainsString( 'bob', $out );
	}

	public function test_stats_with_explicit_sink_name_treats_as_glob(): void {
		// `stats <name>` — no -a — should restrict rows to nodes whose
		// sink IS the named node. Covers the `$expected = $glob` branch.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$ci->dispatch( 'make_node', 'Capture_Sink hub' );
		$ci->dispatch( 'make_node', 'Capture_Sink leaf1' );
		$ci->dispatch( 'set_sink', 'leaf1 hub' );

		$out = $ci->dispatch( 'stats', 'hub' );
		$this->assertStringContainsString( 'leaf1', $out );
		// hub itself sinks into the CI, not into hub, so the row should
		// be absent.
		$this->assertStringNotContainsString( "\nhub ", "\n$out " );
	}

	// ── cmd_debug_state: numeric-arg-with-second-token branch ─────

	public function test_debug_state_self_numeric_first_then_token_treats_as_node_name(): void {
		// `debug_state 1 something` — first arg is numeric BUT there's a
		// second token, so the "numeric-only first arg" branch is bypassed
		// and the cmd treats `1` as a node name. Since there's no node
		// named `1`, it falls into the `unknown node` arm.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$out = $ci->dispatch( 'debug_state', '1 2' );
		$this->assertSame( 'unknown node: 1', $out );
	}

	// ── interpret() error wrap & invalid-struct drop ─────────────

	public function test_interpret_drops_message_with_invalid_command_struct(): void {
		// TM_COMMAND with a malformed JSON VALUE — `interpret()` should
		// drop_message() rather than emit a response. The sink must not
		// see any new envelopes after the drop.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		// VALUE is the command struct directly; a bare string (not an array)
		// is malformed and must be dropped, not echoed.
		$msg[ Message::VALUE ] = 'this is not a command struct';
		$ci->fill( $msg );

		$this->assertCount( 0, $downstream->captured, 'malformed TM_COMMAND must be dropped, not echoed' );
	}

	public function test_interpret_drops_command_without_name_key(): void {
		// JSON decodes fine but no `name` key in the dict — same drop path
		// as the not-an-array case. Covers `! isset( $cmd['name'] )` arm.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::VALUE ] = [ 'arguments' => 'nope' ];
		$ci->fill( $msg );

		$this->assertCount( 0, $downstream->captured );
	}

	public function test_interpret_wraps_handler_exceptions_as_TM_ERROR(): void {
		// Replace the verb table with a handler that throws. The CI must
		// catch it in interpret() and emit a TM_COMMAND|TM_ERROR response
		// back along the FROM trail, instead of crashing the worker.
		// This is the central contract for "verb handlers throw freely;
		// interpret() wraps as TM_ERROR".
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$ci->commands(
			[
				'boom' => static function (): string {
					throw new \RuntimeException( 'kaboom!' );
				},
			]
		);

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::FROM ]  = '_output/777';
		$msg[ Message::VALUE ] = [ 'name' => 'boom', 'arguments' => '' ];
		$msg[ Message::LOCAL ] = true;
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$response = $downstream->captured[0];
		$this->assertSame(
			Message::TM_COMMAND | Message::TM_ERROR,
			$response[ Message::TYPE ],
			'thrown verb errors must be re-emitted as TM_COMMAND|TM_ERROR'
		);
		$this->assertSame( '_output/777', $response[ Message::TO ], 'response walks the FROM trail back' );
		// Response VALUE rides as a live PHP structure — no JSON string to decode.
		$payload = $response[ Message::VALUE ];
		$this->assertSame( 'boom', $payload['name'] );
		$this->assertSame( 'kaboom!', $payload['payload'] );
	}

	public function test_interpret_responds_with_structured_array_payload(): void {
		// A verb returning an array (like dump_node / dump_metadata) must
		// produce a response whose VALUE.payload IS that array — carried as a
		// live structure, not json-encoded. And an EMPTY array result must
		// still produce a response (the `'' !== $result` suppression only
		// catches the empty-STRING case, e.g. `log`).
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$ci->commands(
			[
				'give_array' => static fn (): array => [ 'a' => 1, 'nested' => [ 2, 3 ] ],
				'give_empty' => static fn (): array => [],
			]
		);

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::FROM ]  = '_output/55';
		$msg[ Message::VALUE ] = [ 'name' => 'give_array', 'arguments' => '' ];
		$msg[ Message::LOCAL ] = true;
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$payload = $downstream->captured[0][ Message::VALUE ];
		$this->assertSame( 'give_array', $payload['name'] );
		$this->assertSame( [ 'a' => 1, 'nested' => [ 2, 3 ] ], $payload['payload'], 'array payload rides as a live structure' );

		// Empty-array result still responds (not suppressed).
		$empty                   = Message::new_message();
		$empty[ Message::TYPE ]  = Message::TM_COMMAND;
		$empty[ Message::FROM ]  = '_output/55';
		$empty[ Message::VALUE ] = [ 'name' => 'give_empty', 'arguments' => '' ];
		$empty[ Message::LOCAL ] = true;
		$ci->fill( $empty );

		$this->assertCount( 2, $downstream->captured, 'an empty-array result must still produce a response' );
		$this->assertSame( [], $downstream->captured[1][ Message::VALUE ]['payload'] );
	}

	public function test_interpret_wraps_unknown_command_as_TM_ERROR(): void {
		// An unknown verb makes dispatch() throw InvalidArgumentException;
		// interpret() catches it and wraps the message as TM_COMMAND|TM_ERROR
		// so the cli renders it as an error.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::FROM ]  = '_output/77';
		$msg[ Message::VALUE ] = [ 'name' => 'i_do_not_exist', 'arguments' => '' ];
		$msg[ Message::LOCAL ] = true;
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$response = $downstream->captured[0];
		$this->assertSame(
			Message::TM_COMMAND | Message::TM_ERROR,
			$response[ Message::TYPE ],
			'unknown verbs throw — interpret() wraps as TM_ERROR'
		);
		$payload = $response[ Message::VALUE ];
		$this->assertStringContainsString( 'unknown command', $payload['payload'] );
	}

	public function test_interpret_carries_ID_and_KEY_through_to_response(): void {
		// GUI clients stamp a correlation ID + KEY on outbound commands
		// and expect them mirrored on the response. Make sure interpret()
		// copies both fields (not just FROM/TO) — that's the documented
		// "application-defined correlation metadata" contract.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::FROM ]  = '_output/42';
		$msg[ Message::ID ]    = 'corr-id-123';
		$msg[ Message::KEY ]   = 'gui-tag-abc';
		$msg[ Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => 'Capture_Sink coverage_alice' ];
		$msg[ Message::LOCAL ] = true;
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$response = $downstream->captured[0];
		$this->assertSame( Message::TM_COMMAND | Message::TM_RESPONSE, $response[ Message::TYPE ], 'authorized command yields a success response' );
		$this->assertSame( 'corr-id-123', $response[ Message::ID ] );
		$this->assertSame( 'gui-tag-abc', $response[ Message::KEY ] );
	}

	// ── fill() TM_COMMAND-with-non-empty-TO forwarding ────────────

	public function test_fill_forwards_TM_COMMAND_with_non_empty_TO_to_sink(): void {
		// A TM_COMMAND in transit — TO is still set — must be forwarded
		// through the sink (typically _router) untouched. If the CI
		// dispatched on transit messages, every intermediate CI in a
		// path-routed graph would eat commands meant for downstream peers
		// (see AGENTS.md "CommandInterpreter only handles TM_COMMAND
		// with empty TO").
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::TO ]    = 'some/path/ahead';
		$msg[ Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => 'Capture_Sink not_made' ];
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$this->assertSame( 'some/path/ahead', $downstream->captured[0][ Message::TO ], 'TO preserved on transit' );
		$this->assertNull( Core::node( 'not_made' ), 'CI must not dispatch a transit command' );
	}

	public function test_fill_forwards_TM_COMMAND_TM_RESPONSE_to_sink(): void {
		// Response-flavored TM_COMMAND (the reply leg) must NOT be
		// re-interpreted — otherwise the response payload would round-
		// trip into the verb table and crash. Covers the
		// `! ( $type & TM_RESPONSE )` guard in fill().
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$ci->sink( $downstream );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => 'Capture_Sink ghost_response' ];
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$this->assertNull( Core::node( 'ghost_response' ), 'TM_RESPONSE must not be re-dispatched' );
	}

	// ── node_schema() ────────────────────────────────────────────

	public function test_node_schema_returns_hidden_category(): void {
		// CommandInterpreter's schema marks it Hidden so the editor's
		// palette never offers it for drag-and-drop — it's placed
		// implicitly as a sibling of patron nodes. Locks the description
		// down so future "fix" attempts that flip it to a draggable
		// category trip this test.
		$schema = Command_Interpreter_Node::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertArrayHasKey( 'description', $schema );
		$this->assertSame( [], $schema['ctor'] );
		$this->assertSame( [], $schema['verbs'] );
	}

	// ── make_node instance API: null when class not registered ───

	public function test_make_node_instance_api_returns_null_for_unregistered_class(): void {
		// The cmd_make_node verb returns "unknown class: <type>"; the
		// underlying instance API returns null. Direct unit test, since
		// the verb wraps null into the string.
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$this->assertNull( $ci->make_node( 'NotARegisteredClassEver', 'wont_exist' ) );
		$this->assertNull( Core::node( 'wont_exist' ) );
	}

	public function test_dmesg_returns_recent_log_tail(): void {
		// `dmesg` dumps Core's recent stderr tail — the PHP port of Perl
		// Tachikoma's dmesg (join of @RECENT_LOG). Each entry already carries
		// its trailing newline.
		Core::$recent_log = [ "alpha\n", "beta\n" ];
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$this->assertSame( "alpha\nbeta\n", $ci->dispatch( 'dmesg' ) );
	}
}
