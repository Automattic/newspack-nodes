<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Fleet_Node;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Schema_Reflection;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Vault_Group_Node;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/** A child whose teardown refuses, standing in for a disk that will not flush. */
final class Refusing_Teardown_Node extends Node {
	public function remove_node(): void {
		throw new \RuntimeException( 'teardown refused' );
	}
}

/** A child recording each cursor handoff, as a durable reader answers one. */
final class Handoff_Spy_Node extends Node {
	/** @var list<array{0:string,1:string,2:bool}> Name, stop reason, watermark flag. */
	public static array $handed = [];
	public function hand_off_cursor( string $stop_reason = '', bool $baseline_near_watermark = false ): void {
		self::$handed[] = [ $this->name(), $stop_reason, $baseline_near_watermark ];
	}
}

/** A child that refuses both its arguments and its teardown. */
final class Refusing_Build_Node extends Node {
	public function arguments( ?array $args = null ): array {
		if ( null !== $args ) {
			throw new \RuntimeException( 'arguments refused' );
		}
		return parent::arguments();
	}
	public function remove_node(): void {
		throw new \RuntimeException( 'teardown refused' );
	}
}

/** A child whose `poke` verb records each receipt; the tw0 child raises a stop. */
final class Stop_Spy_Node extends Node {
	use Schema_Reflection;

	/** @var list<string> Names of the children that received `poke`. */
	public static array $poked = [];

	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	public static function node_schema(): array {
		$poke = static function ( Command_Interpreter_Node $ci ): string {
			$name          = $ci->patron()->name();
			self::$poked[] = $name;
			if ( \str_ends_with( $name, ':tw0' ) ) {
				throw new Worker_Should_Stop( 'stop-41' );
			}
			return 'poked';
		};
		return [ 'commands' => [ [ 'name' => 'poke', 'handler' => $poke ] ] ] + parent::node_schema();
	}
}

/** A child with one setter verb and one verb every child refuses. */
final class Knob_Spy_Node extends Node {
	use Schema_Reflection;

	/** The value `set_knob` last wrote. */
	protected string $knob = '';

	public function __construct() {
		parent::__construct();
		$this->auto_wire_interpreter();
	}

	public function set_knob( string $value ): void {
		$this->knob = $value;
	}

	public function dump_config(): string {
		return parent::dump_config() . $this->dump_setters();
	}

	public static function node_schema(): array {
		$refuse = static function (): string {
			throw new \RuntimeException( 'refused-88' );
		};
		return [
			'commands' => [
				[ 'name' => 'set_knob', 'setter' => 'knob', 'args' => [ [ 'name' => 'value', 'type' => 'string' ] ] ],
				[ 'name' => 'tune', 'handler' => $refuse ],
				[ 'name' => 'nudge', 'toggle' => '', 'handler' => static fn (): string => "ok\n" ],
			],
		] + parent::node_schema();
	}
}

#[CoversClass( Vault_Group_Node::class )]
final class VaultGroupNodeTest extends TestCase {

	/** Every stderr line the test run emitted. */
	private string $stderr = '';

	/** Monotonic test clock the fleet's config window reads. */
	private float $clock = 0.0;

	protected function setUp(): void {
		parent::setUp();
		$this->use_base_dir( $this->make_temp_dir() );
		Core::$memd = new InMemoryMemcached();
		// Remote_Source children arm timers; a live graph always has _router.
		( new Router_Node() )->name( Node_Names::ROUTER );
		Core::set_stderr_handler(
			function ( string $text ): void {
				$this->stderr .= $text;
			}
		);
		$this->seed_vault_servers(
			[
				'tw0'  => [ 'url' => 'https://tw0.example', 'group' => 'tw-edge' ],
				'tw9'  => [ 'url' => 'https://tw9.example', 'group' => 'tw-edge' ],
				'lone' => [ 'url' => 'https://lone.example' ],
				'aux'  => [ 'url' => 'https://aux.example', 'group' => 'llm' ],
			]
		);
		$this->clock = Core::right_now();
	}

	protected function tearDown(): void {
		Core::$memd                 = null;
		SSE_In_Node::$curl_dispatch = null;
		Event_Framework::reset();
		Vault::get_instance()->reset_cache();
		parent::tearDown();
	}

	/** @return list<string> The group's member names, in order. */
	private static function member_names( Vault_Group_Node $group ): array {
		return \array_map( static fn ( Node $n ): string => $n->name(), $group->members() );
	}

	public function test_builds_one_named_child_per_member_with_id_substituted(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge', 'cursor.{id}.p3' );
		$this->assertSame( [ 'edge:tw0', 'edge:tw9' ], self::member_names( $group ) );
		$this->assertSame( [ 'tw9', 'cursor.tw9.p3' ], Core::node( 'edge:tw9' )->arguments() );
		$this->assertSame( $group, Core::node( 'edge:tw9' )->publisher() );
		$this->assertNull( Core::node( 'edge:tw9' )->patron() );
		$this->assertSame( $ci, Core::node( 'edge:tw9' )->sink() );
		$this->assertNull( Core::node( 'edge:lone' ) );
		$this->assertNull( Core::node( 'edge:aux' ) );
		$this->assertSame( Node::sibling_name_of( 'edge', 'tw9' ), Core::node( 'edge:tw9' )->name() );
	}

	public function test_expand_is_the_one_spelling(): void {
		$this->assertSame(
			[ 'tw0' => [ [ 'tw0', 'a.tw0', 'b' ] ], 'tw9' => [ [ 'tw9', 'a.tw9', 'b' ] ] ],
			Vault_Group_Node::expand( [ 'tw0', 'tw9' ], [ 'a.{id}', 'b' ] )
		);
	}

	public function test_expand_spells_every_template_list_per_id_and_skips_config(): void {
		$this->assertSame(
			[
				'tw0' => [ [ 'tw0', 'a.tw0' ], [ 'tw0', "'a.tw0'" ] ],
				'tw9' => [ [ 'tw9', 'a.tw9' ], [ 'tw9', "'a.tw9'" ] ],
			],
			Vault_Group_Node::expand( [ 'config', 'tw0', 'tw9' ], [ 'a.{id}' ], [ "'a.{id}'" ] )
		);
	}

	public function test_a_member_added_late_follows_the_ones_built_before_it(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge' );
		Vault::get_instance()->add( 'tw5', [ 'url' => 'https://tw5.example', 'group' => 'tw-edge' ] );
		$group->update_graph();
		$this->assertSame( [ 'edge:tw0', 'edge:tw9', 'edge:tw5' ], self::member_names( $group ) );
	}

	public function test_a_stop_from_one_child_still_reaches_the_rest_then_rethrows(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Unit\\' );
		Stop_Spy_Node::$poked = [];
		$group = ( new Command_Interpreter_Node() )->make_node( 'Vault_Group', 'spy', 'Stop_Spy', 'tw-edge' );
		$this->expectException( Worker_Should_Stop::class );
		$this->expectExceptionMessage( 'stop-41' );
		try {
			$group->interpreter()->dispatch( 'poke' );
		} finally {
			$this->assertSame( [ 'spy:tw0', 'spy:tw9' ], Stop_Spy_Node::$poked );
			$this->assertStringNotContainsString( 'poke', $group->dump_config() );
		}
	}

	public function test_an_unknown_child_type_refuses_the_make_node(): void {
		$ci = new Command_Interpreter_Node();
		$this->expectExceptionMessage( 'unknown child type No_Such_Type' );
		try {
			$ci->make_node( 'Vault_Group', 'edge', 'No_Such_Type', 'tw-edge' );
		} finally {
			$this->assertNull( Core::node( 'edge' ) );
		}
	}

	public function test_config_verb_reaches_every_child_and_later_ones_and_replays(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		$this->assertSame(
			[ 'egress:tw0' => "ok\n", 'egress:tw9' => "ok\n" ],
			Core::node( 'egress:config' )->dispatch( 'allow_replies_to', [ 'settings-sync' ] )
		);
		Vault::get_instance()->add( 'tw5', [ 'url' => 'https://tw5.example', 'group' => 'tw-edge' ] );
		$group->update_graph();
		foreach ( [ 'tw0', 'tw5', 'tw9' ] as $id ) {
			$this->assertInstanceOf( HTTP_Out_Node::class, Core::node( "egress:{$id}" ) );
			$this->assertStringContainsString( 'allow_replies_to settings-sync', Core::node( "egress:{$id}" )->dump_config() );
		}
		$this->assertStringContainsString( "command_node egress:config allow_replies_to settings-sync\n", $group->dump_config() );
	}

	public function test_a_refusal_throws_naming_each_child_and_nothing_is_recorded(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		$this->expectExceptionMessageMatches( '/egress:tw0: usage: allow_replies_to .*; egress:tw9: usage: allow_replies_to /' );
		try {
			$group->interpreter()->dispatch( 'allow_replies_to', [ '' ] );
		} finally {
			$this->assertStringNotContainsString( 'allow_replies_to', $group->dump_config() );
		}
	}

	public function test_a_refusal_answers_as_a_tm_error_through_the_interpreter(): void {
		$ci = new Command_Interpreter_Node();
		$ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		$sink = new Capture_Sink_Node();
		Core::node( 'egress:config' )->sink( $sink );
		$command = Message::new_message();
		$command[ Message::TYPE ]  = Message::TM_COMMAND;
		$command[ Message::FROM ]  = 'asker-3';
		$command[ Message::VALUE ] = [ 'name' => 'allow_replies_to', 'arguments' => [ '' ] ];
		$command[ Message::LOCAL ] = true;
		Core::node( 'egress:config' )->fill( $command );
		$reply = \end( $sink->captured );
		$this->assertSame( Message::TM_COMMAND | Message::TM_ERROR, $reply[ Message::TYPE ] );
		$this->assertStringContainsString( 'egress:tw9: usage: allow_replies_to <path>', $reply[ Message::VALUE ]['payload'] );
	}

	public function test_a_toggled_verb_records_its_last_write(): void {
		$offsets = Config::get_offsets_directory();
		$ci      = new Command_Interpreter_Node();
		$group   = $ci->make_node( 'Vault_Group', 'pull', 'Remote_Source', 'tw-edge', 'firehose.p0', "{$offsets}/pull.firehose.{id}.p0" );
		foreach ( [ 'true', 'false', 'true' ] as $flag ) {
			$group->interpreter()->dispatch( 'set_multi_writer', [ $flag ] );
		}
		$this->assertStringEndsWith( "command_node pull:config set_multi_writer true\n", $group->dump_config() );
		$this->assertSame( 1, \substr_count( $group->dump_config(), 'set_multi_writer true' ) );
		Vault::get_instance()->add( 'tw5', [ 'url' => 'https://tw5.example', 'group' => 'tw-edge' ] );
		$group->update_graph();
		$this->assertStringContainsString( 'set_multi_writer true', Core::node( 'pull:tw5' )->dump_config() );
	}

	public function test_a_read_verb_reaches_every_child_and_is_never_recorded(): void {
		$offsets = Config::get_offsets_directory();
		$ci      = new Command_Interpreter_Node();
		$group   = $ci->make_node( 'Vault_Group', 'pull', 'Remote_Source', 'tw-edge', 'firehose.p0', "{$offsets}/pull.firehose.{id}.p0" );
		$answers = $group->interpreter()->dispatch( 'dl_list', [ '7' ] );
		$this->assertSame( [ 'pull:tw0', 'pull:tw9' ], \array_keys( $answers ) );
		$this->assertStringNotContainsString( 'dl_list', $group->dump_config() );
		$group->interpreter()->dispatch( 'set_multi_writer', [ 'true' ] );
		$this->assertStringContainsString( "command_node pull:config set_multi_writer true\n", $group->dump_config() );
	}

	public function test_a_verb_sent_to_an_empty_group_is_recorded_once(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'arrives-later' );
		$this->assertSame( [], $group->interpreter()->dispatch( 'allow_replies_to', [ 'settings-sync' ] ) );
		$group->interpreter()->dispatch( 'allow_replies_to', [ 'settings-sync' ] );
		$this->assertSame( 1, \substr_count( $group->dump_config(), 'allow_replies_to settings-sync' ) );
		Vault::get_instance()->add( 'tw3', [ 'url' => 'https://tw3.example', 'group' => 'arrives-later' ] );
		$group->update_graph();
		$this->assertStringContainsString( 'allow_replies_to settings-sync', Core::node( 'egress:tw3' )->dump_config() );
	}

	public function test_children_inherit_the_debug_state_like_make_node_nodes(): void {
		$ci = new Command_Interpreter_Node();
		$ci->debug_state( 2 );
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge' );
		$this->assertSame( 2, Core::node( 'edge:tw0' )->debug_state() );
		$group->debug_state( 4 );
		$this->assertSame( 4, Core::node( 'edge:tw9' )->debug_state() );
		Vault::get_instance()->add( 'tw5', [ 'url' => 'https://tw5.example', 'group' => 'tw-edge' ] );
		$group->update_graph();
		$this->assertSame( 4, Core::node( 'edge:tw5' )->debug_state() );
	}

	public function test_an_all_digit_vault_id_builds_and_updates_out(): void {
		Vault::get_instance()->add( '4410', [ 'url' => 'https://d.example', 'group' => 'tw-edge' ] );
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge', 'cursor.{id}' );
		$this->assertSame( [ 'edge:4410', 'edge:tw0', 'edge:tw9' ], self::member_names( $group ) );
		$this->assertSame( [ '4410', 'cursor.4410' ], Core::node( 'edge:4410' )->arguments() );
		Vault::get_instance()->update( '4410', [ 'group' => 'llm' ] );
		$group->update_graph();
		$this->assertNull( Core::node( 'edge:4410' ) );
		$this->assertSame( [ 'edge:tw0', 'edge:tw9' ], self::member_names( $group ) );
	}

	public function test_the_interpreter_dump_replays_the_group_and_none_of_its_children(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( Node_Names::COMMAND_INTERPRETER );
		$ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		$dump = $ci->dispatch( 'dump_config' );
		$this->assertStringContainsString( "make_node Vault_Group egress HTTP_Out tw-edge\n", $dump );
		$this->assertStringNotContainsString( 'egress:tw0', $dump );
		$this->assertStringNotContainsString( 'egress:tw9', $dump );
	}

	public function test_verb_the_child_does_not_declare_is_refused_and_not_recorded(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		$this->expectExceptionMessage( 'unknown command: set_multi_writer' );
		try {
			$group->interpreter()->dispatch( 'set_multi_writer', [ 'true' ] );
		} finally {
			$this->assertStringNotContainsString( 'set_multi_writer', $group->dump_config() );
		}
	}

	public function test_connect_node_cascades_including_to_a_later_child(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge' );
		$group->connect_node( 'rewrite-17' );
		Vault::get_instance()->add( 'tw5', [ 'url' => 'https://tw5.example', 'group' => 'tw-edge' ] );
		$group->update_graph();
		foreach ( [ 'tw0', 'tw5', 'tw9' ] as $id ) {
			$this->assertSame( 'rewrite-17', Core::node( "edge:{$id}" )->target() );
		}
		$this->assertStringContainsString( "connect_node edge rewrite-17\n", $group->dump_config() );
	}

	public function test_disconnect_node_cascades(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge' );
		$group->connect_node( 'rewrite-17' );
		$group->disconnect_node( 'rewrite-17' );
		$this->assertSame( '', Core::node( 'edge:tw0' )->target() );
		$this->assertSame( '', Core::node( 'edge:tw9' )->target() );
	}

	public function test_update_graph_retracts_a_member_that_left_the_group(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge' );
		Vault::get_instance()->update( 'tw9', [ 'group' => 'llm' ] );
		$group->update_graph();
		$this->assertNull( Core::node( 'edge:tw9' ) );
		$this->assertSame( [ 'edge:tw0' ], self::member_names( $group ) );
	}

	public function test_colliding_id_is_skipped_and_the_rest_build(): void {
		Vault::get_instance()->add( 'config', [ 'url' => 'https://c.example', 'group' => 'tw-edge' ] );
		$ci    = new Command_Interpreter_Node();
		$squat = $ci->make_node( 'Echo', 'edge:tw9' );
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge' );
		$this->assertSame( [ 'edge:tw0' ], self::member_names( $group ) );
		$this->assertSame( $squat, Core::node( 'edge:tw9' ) );
		$this->assertStringContainsString( 'Vault id config', $this->stderr );
		$this->assertStringContainsString( 'Vault id tw9', $this->stderr );
	}

	public function test_a_config_id_leaves_the_groups_own_interpreter_standing(): void {
		Vault::get_instance()->add( 'config', [ 'url' => 'https://c.example', 'group' => 'tw-edge' ] );
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		$this->assertSame( [ 'egress:tw0', 'egress:tw9' ], self::member_names( $group ) );
		$this->assertSame( $group->interpreter(), Core::node( 'egress:config' ) );
		$this->assertNotNull( $group->interpreter() );
	}

	public function test_a_child_whose_teardown_throws_is_logged_and_kept(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Unit\\' );
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Refusing_Teardown', 'tw-edge' );
		Vault::get_instance()->update( 'tw9', [ 'group' => 'llm' ] );
		$group->update_graph();
		$this->assertStringContainsString( 'retracting Vault id tw9: teardown refused', $this->stderr );
		$this->assertSame( [ 'edge:tw0', 'edge:tw9' ], self::member_names( $group ) );
	}

	public function test_a_type_change_keeps_a_child_whose_teardown_threw_in_its_slot(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Unit\\' );
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Refusing_Teardown', 'tw-edge' );
		$stuck = $group->members();
		$group->arguments( [ 'Echo', 'tw-edge' ] );
		$this->assertStringContainsString( 'retracting Vault id tw0: teardown refused', $this->stderr );
		$this->assertSame( $stuck, $group->members() );
	}

	public function test_a_refused_build_whose_cleanup_throws_escapes_nothing(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Unit\\' );
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Refusing_Build', 'tw-edge' );
		$this->assertStringContainsString( 'skipping Vault id tw0: arguments refused', $this->stderr );
		$this->assertStringContainsString( 'retracting Vault id tw0: teardown refused', $this->stderr );
		$this->assertSame( [ 'edge:tw0', 'edge:tw9' ], self::member_names( $group ) );
	}

	/** Mount a `_fleet` a group can subscribe to, as a live worker graph has. */
	private function mount_fleet(): array {
		$base     = $this->make_temp_dir( 'group-fleet-' );
		$lock_dir = "{$base}/locks/group-lab.p0.lock.d";
		\mkdir( $lock_dir, 0755, true );
		$fleet = new Fleet_Node();
		$fleet->name( Node_Names::FLEET );
		$fleet->sink( Core::node( Node_Names::ROUTER ) );
		$fleet->arguments( [ $base, $lock_dir ] );
		return [ $fleet, $lock_dir ];
	}

	/** Signal a reload the way a Vault save does, then run the fleet's window. */
	private function signal_reload( Fleet_Node $fleet, string $lock_dir ): void {
		Lock_Node::request_reload_at( $lock_dir );
		$this->clock += ( Fleet_Node::SCAN_INTERVAL_MS / 1000 ) + 1;
		Core::$now    = $this->clock;
		$fleet->fire_cb();
	}

	/** @return list<string> The RELOAD subscriber keys registered on the fleet. */
	private function reload_subscribers( Fleet_Node $fleet ): array {
		return \array_keys( $this->read_private( $fleet, 'registrations' )['RELOAD'] ?? [] );
	}

	public function test_empty_group_builds_its_first_member_on_reload(): void {
		[ $fleet, $lock_dir ] = $this->mount_fleet();
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'late', 'Echo', 'arrives-later' );
		$this->assertSame( [], $group->members() );
		\update_option(
			Vault::OPTION_KEY,
			\get_option( Vault::OPTION_KEY ) + [ 'tw3' => [ 'url' => 'https://tw3.example', 'group' => 'arrives-later' ] ]
		);
		$this->signal_reload( $fleet, $lock_dir );
		$this->assertInstanceOf( Echo_Node::class, Core::node( 'late:tw3' ) );
	}

	#[\PHPUnit\Framework\Attributes\RunInSeparateProcess]
	public function test_a_fleet_reload_retracts_a_member_another_process_removed(): void {
		// A worker's WordPress caches the option under its own key on first read.
		require_once __DIR__ . '/../Helpers/wp-object-cache-stub.php';
		[ $fleet, $lock_dir ] = $this->mount_fleet();
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge' );
		$this->assertSame( [ 'edge:tw0', 'edge:tw9' ], self::member_names( $group ) );

		// The Vault tab's delete reaches the shared cache, not this worker's copy.
		$servers = $GLOBALS['_wp_options'][ Vault::OPTION_KEY ];
		unset( $servers['tw9'] );
		\wp_test_write_elsewhere( Vault::OPTION_KEY, $servers, false );
		$this->signal_reload( $fleet, $lock_dir );

		$this->assertSame( [ 'edge:tw0' ], self::member_names( $group ) );
		$this->assertNull( Core::node( 'edge:tw9' ) );
	}

	public function test_a_fleet_reload_retracts_a_later_remote_source_quietly(): void {
		[ $fleet, $lock_dir ] = $this->mount_fleet();
		$offsets = Config::get_offsets_directory();
		$ci      = new Command_Interpreter_Node();
		$ci->make_node( 'Vault_Group', 'pull', 'Remote_Source', 'tw-edge', 'firehose.p0', "{$offsets}/pull.firehose.{id}.p0" );
		Vault::get_instance()->add( 'tw5', [ 'url' => 'https://tw5.example', 'group' => 'tw-edge' ] );
		$this->signal_reload( $fleet, $lock_dir );
		$this->assertInstanceOf( Remote_Source_Node::class, Core::node( 'pull:tw5' ) );
		Vault::get_instance()->update( 'tw5', [ 'group' => 'llm' ] );
		$this->signal_reload( $fleet, $lock_dir );
		$this->assertNull( Core::node( 'pull:tw5' ) );
		$this->assertNotContains( 'pull:tw5', $this->reload_subscribers( $fleet ) );
		$this->assertStringNotContainsString( 'forgot to unregister', $this->stderr );
	}

	public function test_a_rename_carries_the_children_and_the_reload_subscription(): void {
		[ $fleet, $lock_dir ] = $this->mount_fleet();
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge' );
		$group->name( 'rim' );
		$this->assertSame( [ 'rim:tw0', 'rim:tw9' ], self::member_names( $group ) );
		$this->assertContains( 'rim', $this->reload_subscribers( $fleet ) );
		$this->assertNotContains( 'edge', $this->reload_subscribers( $fleet ) );
	}

	public function test_removing_the_group_tears_every_child_down(): void {
		[ $fleet ] = $this->mount_fleet();
		$ci        = new Command_Interpreter_Node();
		$group     = $ci->make_node( 'Vault_Group', 'edge', 'Echo', 'tw-edge' );
		$this->assertContains( 'edge', $this->reload_subscribers( $fleet ) );
		$group->remove_node();
		$this->assertNull( Core::node( 'edge:tw0' ) );
		$this->assertNull( Core::node( 'edge:tw9' ) );
		$this->assertSame( [], $group->members() );
		$this->assertNotContains( 'edge', $this->reload_subscribers( $fleet ) );
	}

	public function test_replay_with_another_child_type_rewires_the_verbs(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'edge', 'HTTP_Out', 'tw-edge' );
		$group->interpreter()->dispatch( 'allow_replies_to', [ 'settings-sync' ] );
		$group->arguments( [ 'Echo', 'tw-edge' ] );
		$this->assertInstanceOf( Echo_Node::class, Core::node( 'edge:tw0' ) );
		$this->assertInstanceOf( Echo_Node::class, Core::node( 'edge:tw9' ) );
		$this->assertNull( $group->interpreter() );
		$this->assertNull( Core::node( 'edge:config' ) );
		$this->assertStringNotContainsString( 'allow_replies_to', $group->dump_config() );
	}

	public function test_a_departed_child_hands_its_cursor_off_whatever_its_class(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Unit\\' );
		Handoff_Spy_Node::$handed = [];
		$group = ( new Command_Interpreter_Node() )->make_node( 'Vault_Group', 'edge', 'Handoff_Spy', 'tw-edge' );
		Vault::get_instance()->update( 'tw9', [ 'group' => 'llm' ] );
		$group->update_graph();
		$this->assertSame( [ [ 'edge:tw9', '', false ] ], Handoff_Spy_Node::$handed );
		$this->assertNull( Core::node( 'edge:tw9' ) );
	}

	public function test_a_retracted_remote_source_hands_its_cursor_off_and_throws_nothing(): void {
		SSE_In_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		$offsets = Config::get_offsets_directory();
		$sink    = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$group = new Vault_Group_Node();
		$group->name( 'pull' );
		$group->sink( $sink );
		$group->arguments( [ 'Remote_Source', 'tw-edge', 'firehose.p0', "{$offsets}/pull.firehose.{id}.p0" ] );
		$group->connect_node( 'downstream' );

		$child = Core::node( 'pull:tw9' );
		$this->assertInstanceOf( Remote_Source_Node::class, $child );
		$child->fire();
		Core::node( 'pull:tw9:sse-in' )->process_sse_chunk( self::msg_frame( '9:512:40', '', [ 'p' => 1 ] ) );
		$child->poll();
		$this->assertCount( 1, $sink->captured );

		Vault::get_instance()->update( 'tw9', [ 'group' => 'llm' ] );
		$group->update_graph();

		$this->assertNull( Core::node( 'pull:tw9' ) );
		$logs = \glob( "{$offsets}/pull.firehose.tw9.p0/*.log" );
		$this->assertNotEmpty( $logs, 'the retracted child wrote its cursor' );
		$lines = \array_values( \array_filter( \explode( "\n", (string) \file_get_contents( \end( $logs ) ) ) ) );
		$frame = Message::unpacked( \end( $lines ) )[ Message::VALUE ];
		$this->assertSame( 9, $frame['segment'] );
		$this->assertSame( 552, $frame['offset'] );
		$this->assertSame( 0, $frame['attempts'] );
		$this->assertStringNotContainsString( 'retracting Vault id', $this->stderr );
	}

	public function test_a_refused_child_type_leaves_the_group_as_it_was(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		$group->interpreter()->dispatch( 'allow_replies_to', [ 'settings-sync' ] );
		$state = fn (): array => [ $this->read_private( $group, 'group' ), $this->read_private( $group, 'child_type' ), $group->arguments(), $group->members(), $group->dump_config() ];
		$before = $state();
		try {
			$group->arguments( [ 'Bogus', 'other-group' ] );
			$this->fail( 'an unknown child type must refuse' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'unknown child type Bogus', $e->getMessage() );
		}
		$this->assertSame( $before, $state() );
	}

	public function test_a_bare_make_node_names_the_missing_child_type(): void {
		$ci = new Command_Interpreter_Node();
		try {
			$ci->make_node( 'Vault_Group', 'bare-7' );
			$this->fail( 'a missing child type must refuse' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertSame( 'Missing required argument: child_type', $e->getMessage() );
		}
		$this->assertNull( Core::node( 'bare-7' ) );
	}

	public function test_a_reconfiguration_with_no_tokens_leaves_the_group_as_it_was(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		$state = fn (): array => [ $this->read_private( $group, 'group' ), $this->read_private( $group, 'child_type' ), $group->arguments(), $group->members(), $group->dump_config() ];
		$before = $state();
		try {
			$group->arguments( [] );
			$this->fail( 'a missing child type must refuse' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertSame( 'Missing required argument: child_type', $e->getMessage() );
		}
		$this->assertSame( $before, $state() );
	}

	public function test_a_missing_group_leaves_the_child_type_as_it_was(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		try {
			$group->arguments( [ 'Echo' ] );
			$this->fail( 'a missing group must refuse' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'Missing required argument: group', $e->getMessage() );
		}
		$this->assertSame( 'HTTP_Out', $this->read_private( $group, 'child_type' ) );
		$this->assertSame( [ 'HTTP_Out', 'tw-edge' ], $group->arguments() );
	}

	public function test_a_message_filled_into_the_group_reaches_no_child_and_no_target(): void {
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$group = new Vault_Group_Node();
		$group->name( 'edge' );
		$group->sink( $sink );
		$group->arguments( [ 'Echo', 'tw-edge' ] );
		$group->connect_node( 'downstream' );
		$message                  = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'relay-31';
		$message[ Message::VALUE ] = 'hello-52';
		$group->fill( $message );
		$this->assertSame( [], $sink->captured );
		$this->assertStringContainsString( 'edge', $this->stderr );
		$this->assertStringContainsString( 'connect a fan-out source to it', $this->stderr );
		$this->assertStringContainsString( 'relay-31', $this->stderr );
		$this->assertStringContainsString( 'TM_INFO', $this->stderr );
		$this->assertStringNotContainsString( 'Discovery_Collector', $this->stderr );
	}

	public function test_a_setter_resent_keeps_one_entry_holding_its_last_value(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Unit\\' );
		$group = ( new Command_Interpreter_Node() )->make_node( 'Vault_Group', 'dial', 'Knob_Spy', 'tw-edge' );
		foreach ( [ '5', '6', '7' ] as $value ) {
			$group->interpreter()->dispatch( 'set_knob', [ $value ] );
		}
		$this->assertSame( 1, \substr_count( $group->dump_config(), 'set_knob' ) );
		$this->assertStringEndsWith( "command_node dial:config set_knob 7\n", $group->dump_config() );
	}

	public function test_a_handler_verb_keeps_one_entry_per_distinct_argument(): void {
		$ci    = new Command_Interpreter_Node();
		$group = $ci->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		foreach ( [ 'settings-sync', 'aggregator-3' ] as $path ) {
			$group->interpreter()->dispatch( 'allow_replies_to', [ $path ] );
		}
		$this->assertSame( 2, \substr_count( $group->dump_config(), 'allow_replies_to' ) );
	}

	public function test_a_handler_verb_with_an_empty_toggle_records_by_verb_and_args(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Unit\\' );
		$group = ( new Command_Interpreter_Node() )->make_node( 'Vault_Group', 'dial', 'Knob_Spy', 'arrives-later' );
		foreach ( [ 'north-4', 'south-9' ] as $way ) {
			$group->interpreter()->dispatch( 'nudge', [ $way ] );
		}
		$this->assertSame( 2, \substr_count( $group->dump_config(), 'nudge' ) );
	}

	public function test_a_replayed_command_a_later_child_refuses_names_the_verb_and_args(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Unit\\' );
		$group = ( new Command_Interpreter_Node() )->make_node( 'Vault_Group', 'dial', 'Knob_Spy', 'arrives-later' );
		$group->interpreter()->dispatch( 'tune', [ 'knob-61', 'fast' ] );
		Vault::get_instance()->add( 'tw3', [ 'url' => 'https://tw3.example', 'group' => 'arrives-later' ] );
		$group->update_graph();
		$this->assertStringContainsString( 'skipping Vault id tw3: replaying tune knob-61 fast: refused-88', $this->stderr );
		$this->assertNull( Core::node( 'dial:tw3' ) );
	}
}
