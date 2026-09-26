<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Core;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Message;
use Newspack_Nodes\Settings_Sync_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Settings_Sync_Node::class )]
class SettingsSyncNodeTest extends TestCase {

	/** wired_node() mints a real 'tw0' session; leaked, it makes a later no-session test find one. */
	protected function tearDown(): void {
		Command_Auth::forget_session( 'tw0' );
		parent::tearDown();
	}

	public function test_add_setting_registers_entry(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$result = $node->add_setting( [ 'newspack_nodes_num_partitions', 'settings', 'newspack_nodes_num_partitions' ] );

		$this->assertSame( "ok\n", $result );

		$ref      = new \ReflectionProperty( $node, 'registry' );
		$registry = $ref->getValue( $node );
		$this->assertSame(
			[
				'newspack_nodes_num_partitions' => [
					[
						'to'     => 'settings',
						'remote' => 'newspack_nodes_num_partitions',
					],
				],
			],
			$registry
		);
	}

	public function test_dump_config_re_emits_add_setting_line(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );
		$node->add_setting( [ 'newspack_nodes_num_partitions', 'settings', 'newspack_nodes_num_partitions' ] );

		$this->assertStringContainsString(
			'command_node settings-sync:config add_setting newspack_nodes_num_partitions settings newspack_nodes_num_partitions',
			$node->dump_config()
		);
	}

	public function test_add_setting_wrong_arity_refuses_and_leaves_registry_unchanged(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		try {
			$node->add_setting( [ 'only', 'two' ] );
			$this->fail( 'add_setting accepted two tokens' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringStartsWith( 'usage: add_setting', $e->getMessage() );
		}

		$ref = new \ReflectionProperty( $node, 'registry' );
		$this->assertSame( [], $ref->getValue( $node ) );
	}

	public function test_node_schema_is_control_and_lists_add_setting(): void {
		$schema = Settings_Sync_Node::node_schema();

		$this->assertSame( 'Control', $schema['category'] );
		$verb_names = \array_column( $schema['commands'], 'name' );
		$this->assertContains( 'add_setting', $verb_names );
	}

	public function test_node_schema_exposes_interval_seconds_constructor_arg(): void {
		$arg_names = \array_column( Settings_Sync_Node::node_schema()['arguments'], 'name' );
		$this->assertContains( 'interval_seconds', $arg_names, 'editor CONSTRUCTOR panel must surface the interval arg' );
	}

	public function test_config_verb_dispatches_to_add_setting(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$sibling = Core::node( 'settings-sync:config' );
		$this->assertNotNull( $sibling );

		$result = $sibling->dispatch( 'add_setting', [ 'newspack_nodes_num_partitions', 'settings', 'newspack_nodes_num_partitions' ] );
		$this->assertSame( "ok\n", $result );

		$ref = new \ReflectionProperty( $node, 'registry' );
		$this->assertArrayHasKey( 'newspack_nodes_num_partitions', $ref->getValue( $node ) );
	}

	/**
	 * Settings_Sync now mints one SIGNED command per spoke, so the harness wires a
	 * real egress node and gives it a session — a target it cannot sign for is
	 * skipped, which is the point of the change.
	 */
	private function wired_node( Capture_Sink_Node $sink ): Settings_Sync_Node {
		$sink->name( '_command_interpreter' );
		\update_option( Vault::OPTION_KEY, [ 'tw0' => [ 'url' => 'https://tw0.example' ] ] );
		Vault::get_instance()->reset_cache();
		$this->egress( 'spokes:tw0', 'tw0' );
		Command_Auth::remember_session( 'tw0', \str_repeat( '5', 32 ), 'harness-session-key' );

		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );
		$node->sink( $sink );
		$node->connect_node( 'spokes:tw0' );
		return $node;
	}

	public function test_fill_emits_set_command_for_registered_option(): void {
		\update_option( 'newspack_nodes_max_segments', 8 );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'newspack_nodes_max_segments', 'settings', 'newspack_nodes_max_segments' ] );

		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_STRUCT;
		$msg[ Message::VALUE ]     = [ 'option' => 'newspack_nodes_max_segments' ];
		$node->fill( $msg );

		$this->assertCount( 1, $sink->captured );
		$out = $sink->captured[0];
		$this->assertSame( Message::TM_COMMAND, $out[ Message::TYPE ] );
		$this->assertSame( 'spokes:tw0/settings', $out[ Message::TO ] );
		$this->assertSame( 'set', $out[ Message::VALUE ]['name'] );
		$this->assertSame( [ 'newspack_nodes_max_segments', '8' ], $out[ Message::VALUE ]['arguments'] );
		$this->assertSame( \str_repeat( '5', 32 ), $out[ Message::VALUE ]['auth']['handle'] );
	}

	public function test_add_setting_twice_for_same_local_pushes_to_each_remote(): void {
		// A hub-local `remote_*` setting seeds BOTH the spoke's stripped option
		// (its actual config) AND the spoke's own `remote_*` copy (so the spoke can
		// propagate it onward to ITS spokes). Two add_setting lines, same local.
		\update_option( 'newspack_nodes_remote_max_segments', 5 );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'newspack_nodes_remote_max_segments', 'settings', 'newspack_nodes_max_segments' ] );
		$node->add_setting( [ 'newspack_nodes_remote_max_segments', 'settings', 'newspack_nodes_remote_max_segments' ] );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'newspack_nodes_remote_max_segments' ];
		$node->fill( $msg );

		$this->assertCount( 2, $sink->captured );
		$args = \array_map(
			static fn ( $m ) => $m[ Message::VALUE ]['arguments'],
			$sink->captured
		);
		$this->assertContains( [ 'newspack_nodes_max_segments', '5' ], $args );
		$this->assertContains( [ 'newspack_nodes_remote_max_segments', '5' ], $args );
	}

	public function test_add_setting_dedupes_exact_duplicate_mappings(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );
		$node->add_setting( [ 'a', 'settings', 'b' ] );
		$node->add_setting( [ 'a', 'settings', 'b' ] );

		$ref = new \ReflectionProperty( $node, 'registry' );
		$this->assertCount( 1, $ref->getValue( $node )['a'] );
	}

	#[\PHPUnit\Framework\Attributes\RunInSeparateProcess]
	public function test_push_rereads_a_non_schema_option_another_process_wrote(): void {
		// A worker's runtime copy keeps a non-autoloaded option under its own key.
		require_once __DIR__ . '/../Helpers/wp-object-cache-stub.php';
		\update_option( 'spoke_probe_ceiling', '2', false );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'spoke_probe_ceiling', 'settings', 'spoke_probe_ceiling' ] );

		// The admin's save reaches the shared cache, not this worker's copy.
		\wp_test_write_elsewhere( 'spoke_probe_ceiling', '9', false );
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'spoke_probe_ceiling' ];
		$node->fill( $msg );

		$this->assertSame( [ 'spoke_probe_ceiling', '9' ], $sink->captured[0][ Message::VALUE ]['arguments'] );
	}

	#[\PHPUnit\Framework\Attributes\RunInSeparateProcess]
	public function test_push_reads_an_option_absent_at_first_read_and_set_later(): void {
		// WordPress caches the ABSENCE of a row it read, in `notoptions`.
		require_once __DIR__ . '/../Helpers/wp-object-cache-stub.php';
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'spoke_probe_ceiling', 'settings', 'spoke_probe_ceiling' ] );
		$this->assertFalse( \get_option( 'spoke_probe_ceiling' ) );

		\wp_test_write_elsewhere( 'spoke_probe_ceiling', '9', false );
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'spoke_probe_ceiling' ];
		$node->fill( $msg );

		$this->assertSame( [ 'spoke_probe_ceiling', '9' ], $sink->captured[0][ Message::VALUE ]['arguments'] );
	}

	#[\PHPUnit\Framework\Attributes\RunInSeparateProcess]
	public function test_fire_rereads_every_autoloaded_option_through_one_flush(): void {
		require_once __DIR__ . '/../Helpers/wp-object-cache-stub.php';
		\update_option( 'spoke_probe_ceiling', '2' );
		\update_option( 'spoke_probe_floor', '3' );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'spoke_probe_ceiling', 'settings', 'spoke_probe_ceiling' ] );
		$node->add_setting( [ 'spoke_probe_floor', 'settings', 'spoke_probe_floor' ] );
		$node->fire();

		// Both saves reach the shared `alloptions`, behind this worker's copy.
		\wp_test_write_elsewhere( 'spoke_probe_ceiling', '9' );
		\wp_test_write_elsewhere( 'spoke_probe_floor', '7' );
		$sink->captured               = [];
		$GLOBALS['_wp_cache_flushes'] = [];
		$node->fire();

		$this->assertSame(
			[ [ 'spoke_probe_ceiling', '9' ], [ 'spoke_probe_floor', '7' ] ],
			\array_map( static fn ( array $m ): array => $m[ Message::VALUE ]['arguments'], $sink->captured )
		);
		$this->assertSame( [ 'runtime' ], $GLOBALS['_wp_cache_flushes'], 'one flush per sweep, evicting nothing shared' );
		$this->assertSame( '7', $GLOBALS['_wp_option_shared']['alloptions']['spoke_probe_floor'] );
	}

	#[\PHPUnit\Framework\Attributes\RunInSeparateProcess]
	public function test_the_value_filter_reads_another_option_fresh_without_an_external_cache(): void {
		// ELN's filter hydrates a pointer rule from a non-autoloaded option.
		require_once __DIR__ . '/../Helpers/wp-object-cache-stub.php';
		$GLOBALS['_wp_using_ext_object_cache'] = false;
		\update_option( 'spoke_probe_ceiling', '2', false );
		\update_option( 'spoke_probe_hooks', 'save_post', false );
		\add_filter(
			'newspack_nodes/settings_sync/value',
			static fn ( $value ): string => $value . ':' . \get_option( 'spoke_probe_hooks' )
		);
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'spoke_probe_ceiling', 'settings', 'spoke_probe_ceiling' ] );
		$node->fire();

		\wp_test_write_elsewhere( 'spoke_probe_hooks', 'wp_loaded', false );
		$sink->captured = [];
		$node->fire();

		$this->assertSame( [ 'spoke_probe_ceiling', '2:wp_loaded' ], $sink->captured[0][ Message::VALUE ]['arguments'] );
	}

	public function test_fill_scalarizes_array_value_to_json(): void {
		// Array option values ride the wire as JSON, not a comma-list — lossless
		// even for associative maps (custom_events: event_name => true), whose keys
		// implode() would drop. Parse the emitted args back and json_decode the
		// value to assert the round-trip rather than match the escaped wire string.
		\update_option( 'newspack_nodes_remote_servers', [ 'a.com', 'b.com' ] );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'newspack_nodes_remote_servers', 'settings', 'newspack_nodes_remote_servers' ] );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'newspack_nodes_remote_servers' ];
		$node->fill( $msg );

		$parsed = \Newspack_Nodes\Command_Args::parse( $sink->captured[0][ Message::VALUE ]['arguments'] );
		$this->assertSame( 'newspack_nodes_remote_servers', $parsed['positional'][0] );
		$this->assertSame( [ 'a.com', 'b.com' ], \json_decode( $parsed['positional'][1], true ) );
	}

	public function test_fill_preserves_associative_array_keys_via_json(): void {
		// The custom_events shape: keys ARE the data. implode(',') would emit a
		// meaningless "1,1"; JSON keeps the event names.
		\update_option( 'newspack_nodes_remote_servers', [ 'advancedemail' => true, 'amazons3' => true ] );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'newspack_nodes_remote_servers', 'settings', 'newspack_nodes_remote_servers' ] );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'newspack_nodes_remote_servers' ];
		$node->fill( $msg );

		$parsed = \Newspack_Nodes\Command_Args::parse( $sink->captured[0][ Message::VALUE ]['arguments'] );
		$this->assertSame(
			[ 'advancedemail' => true, 'amazons3' => true ],
			\json_decode( $parsed['positional'][1], true )
		);
	}

	public function test_push_skips_when_value_cannot_be_encoded(): void {
		// A value json_encode rejects (malformed UTF-8) must NOT emit a `set` with
		// an empty argument — that would decode to [] on the spoke and WIPE the
		// option. push() drops it instead (rate-limited log), leaving the spoke be.
		\update_option( 'newspack_nodes_remote_servers', [ "bad\xB1utf8" ] );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'newspack_nodes_remote_servers', 'settings', 'newspack_nodes_remote_servers' ] );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'newspack_nodes_remote_servers' ];
		$node->fill( $msg );

		$this->assertCount( 0, $sink->captured );
	}

	public function test_fill_drops_unregistered_option(): void {
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'never_registered' ];
		$node->fill( $msg );

		$this->assertCount( 0, $sink->captured );
		$this->assertSame( [], $GLOBALS['_wp_cache_flushes'], 'an event nothing pushes pays no flush' );
	}

	public function test_a_node_with_no_spokes_pays_no_flush_for_a_registered_option(): void {
		$sink = new Capture_Sink_Node();
		$sink->name( '_command_interpreter' );
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );
		$node->sink( $sink );
		$node->add_setting( [ 'spoke_probe_ceiling', 'settings', 'spoke_probe_ceiling' ] );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'spoke_probe_ceiling' ];
		$node->fill( $msg );
		$node->fire();

		$this->assertSame( [], $GLOBALS['_wp_cache_flushes'] );
	}

	public function test_a_sweep_with_nothing_registered_pays_no_flush(): void {
		$node = $this->wired_node( new Capture_Sink_Node() );

		$node->fire();

		$this->assertSame( [], $GLOBALS['_wp_cache_flushes'] );
	}

	public function test_fill_honors_value_resolver_filter(): void {
		\update_option( 'newspack_nodes_max_segments', 8 );
		$filter = static fn ( $value, $option ) => 'newspack_nodes_max_segments' === $option ? 99 : $value;
		\add_filter( 'newspack_nodes/settings_sync/value', $filter, 10, 2 );

		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'newspack_nodes_max_segments', 'settings', 'newspack_nodes_max_segments' ] );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'newspack_nodes_max_segments' ];
		$node->fill( $msg );

		\remove_action( 'newspack_nodes/settings_sync/value', $filter );

		$out = $sink->captured[0];
		$this->assertSame( [ 'newspack_nodes_max_segments', '99' ], $out[ Message::VALUE ]['arguments'] );
	}

	public function test_fill_ignores_non_struct_message(): void {
		\update_option( 'newspack_nodes_max_segments', 8 );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'newspack_nodes_max_segments', 'settings', 'newspack_nodes_max_segments' ] );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = [ 'option' => 'newspack_nodes_max_segments' ];
		$node->fill( $msg );

		$this->assertCount( 0, $sink->captured );
	}

	public function test_fire_pushes_every_registered_option_in_one_call(): void {
		\update_option( 'newspack_nodes_max_segments', 8 );
		\update_option( 'newspack_nodes_num_partitions', 4 );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( [ 'newspack_nodes_max_segments', 'settings', 'newspack_nodes_max_segments' ] );
		$node->add_setting( [ 'newspack_nodes_num_partitions', 'settings', 'newspack_nodes_num_partitions' ] );

		$node->fire();

		$this->assertCount( 2, $sink->captured );
		foreach ( $sink->captured as $out ) {
			$this->assertSame( 'set', $out[ Message::VALUE ]['name'] );
		}
	}

	public function test_arguments_arms_recurring_timer(): void {
		// A 300s cadence (interval_ms > 1000) now hitchhikes the Router TIMER and
		// throttles in fire_cb() — a real worker drain always has a _router.
		$router = new \Newspack_Nodes\Router_Node();
		$router->name( \Newspack_Nodes\Node_Names::ROUTER );
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$node->arguments( [ '300' ] );

		$ref = new \ReflectionObject( $node );
		$this->assertSame( 300000, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
		$mode = $ref->getProperty( 'mode' );
		$this->assertSame( 'router', $mode->getValue( $node ) );
	}

	public function test_arguments_blank_arms_default_cadence(): void {
		$router = new \Newspack_Nodes\Router_Node();
		$router->name( \Newspack_Nodes\Node_Names::ROUTER );
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$node->arguments( [] );

		$this->assertSame( 300000, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
	}

	public function test_arguments_arms_explicit_non_default_cadence(): void {
		$router = new \Newspack_Nodes\Router_Node();
		$router->name( \Newspack_Nodes\Node_Names::ROUTER );
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$node->arguments( [ '7' ] );

		$this->assertSame( 7000, $node->interval_ms );
	}

	public function test_arguments_rejects_non_numeric_interval(): void {
		$router = new \Newspack_Nodes\Router_Node();
		$router->name( \Newspack_Nodes\Node_Names::ROUTER );
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$this->expectException( \InvalidArgumentException::class );

		$node->arguments( [ 'abc' ] );
	}

	public function test_arguments_rejects_negative_interval(): void {
		$router = new \Newspack_Nodes\Router_Node();
		$router->name( \Newspack_Nodes\Node_Names::ROUTER );
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$this->expectException( \InvalidArgumentException::class );

		$node->arguments( [ '-7' ] );
	}

	/** A zero interval must never take an own 0 ms slot: that free-spins the drain. */
	public function test_arguments_floors_zero_interval_onto_the_router_hitchhike(): void {
		$router = new \Newspack_Nodes\Router_Node();
		$router->name( \Newspack_Nodes\Node_Names::ROUTER );
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$node->arguments( [ '0' ] );

		$ref  = new \ReflectionObject( $node );
		$mode = $ref->getProperty( 'mode' );
		$this->assertSame( 1000, $node->interval_ms );
		$this->assertSame( 'router', $mode->getValue( $node ) );
	}

	/**
	 * The spoke `set` handler parses arguments via Command_Args::parse()['positional'].
	 * format([$remote,$value],[]) MUST round-trip back to those two positionals — including
	 * a csv value (comma) and a value with spaces (must be quoted to survive tokenization).
	 */
	public function test_command_args_round_trips_positional_value(): void {
		foreach ( [ '8', 'a.com,b.com', 'has spaces here', '' ] as $value ) {
			$args   = Command_Args::format( [ 'newspack_nodes_remote_servers', $value ], [] );
			$parsed = Command_Args::parse( $args )['positional'];
			$this->assertSame( [ 'newspack_nodes_remote_servers', $value ], $parsed, "round-trip failed for value: $value" );
		}
	}
}
