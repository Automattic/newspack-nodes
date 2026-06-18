<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Settings_Sync_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Settings_Sync_Node::class )]
class SettingsSyncNodeTest extends TestCase {

	public function test_add_setting_registers_entry(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$result = $node->add_setting( 'newspack_nodes_num_partitions settings newspack_nodes_num_partitions' );

		$this->assertSame( 'ok', $result );

		$ref      = new \ReflectionProperty( $node, 'registry' );
		$registry = $ref->getValue( $node );
		$this->assertSame(
			[
				'newspack_nodes_num_partitions' => [
					'to'     => 'settings',
					'remote' => 'newspack_nodes_num_partitions',
				],
			],
			$registry
		);
	}

	public function test_dump_config_re_emits_add_setting_line(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );
		$node->add_setting( 'newspack_nodes_num_partitions settings newspack_nodes_num_partitions' );

		$this->assertStringContainsString(
			'cmd settings-sync:config add_setting newspack_nodes_num_partitions settings newspack_nodes_num_partitions',
			$node->dump_config()
		);
	}

	public function test_add_setting_wrong_arity_returns_error_and_leaves_registry_unchanged(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$result = $node->add_setting( 'only two' );

		$this->assertStringStartsWith( 'error:', $result );

		$ref = new \ReflectionProperty( $node, 'registry' );
		$this->assertSame( [], $ref->getValue( $node ) );
	}

	public function test_node_schema_is_control_and_lists_add_setting(): void {
		$schema = Settings_Sync_Node::node_schema();

		$this->assertSame( 'Control', $schema['category'] );
		$verb_names = \array_column( $schema['commands'], 'name' );
		$this->assertContains( 'add_setting', $verb_names );
	}

	public function test_config_verb_dispatches_to_add_setting(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$sibling = Core::node( 'settings-sync:config' );
		$this->assertNotNull( $sibling );

		$result = $sibling->dispatch( 'add_setting', 'newspack_nodes_num_partitions settings newspack_nodes_num_partitions' );
		$this->assertSame( 'ok', $result );

		$ref = new \ReflectionProperty( $node, 'registry' );
		$this->assertArrayHasKey( 'newspack_nodes_num_partitions', $ref->getValue( $node ) );
	}

	/** Build a named Settings_Sync_Node wired to a capturing sink and connected to a Tee target. */
	private function wired_node( Capture_Sink_Node $sink ): Settings_Sync_Node {
		$sink->name( '_command_interpreter' );
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );
		$node->sink( $sink );
		$node->connect_node( 'spokes:tee' );
		return $node;
	}

	public function test_fill_emits_set_command_for_registered_option(): void {
		\update_option( 'newspack_nodes_num_segments', 8 );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( 'newspack_nodes_num_segments settings newspack_nodes_num_segments' );

		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_STRUCT;
		$msg[ Message::VALUE ]     = [ 'option' => 'newspack_nodes_num_segments' ];
		$node->fill( $msg );

		$this->assertCount( 1, $sink->captured );
		$out = $sink->captured[0];
		$this->assertSame( Message::TM_COMMAND, $out[ Message::TYPE ] );
		$this->assertSame( 'spokes:tee/settings', $out[ Message::TO ] );
		$this->assertSame( 'set', $out[ Message::VALUE ]['name'] );
		$this->assertSame( 'newspack_nodes_num_segments 8', $out[ Message::VALUE ]['arguments'] );
	}

	public function test_fill_scalarizes_array_value_to_csv(): void {
		\update_option( 'newspack_nodes_remote_servers', [ 'a.com', 'b.com' ] );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( 'newspack_nodes_remote_servers settings newspack_nodes_remote_servers' );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'newspack_nodes_remote_servers' ];
		$node->fill( $msg );

		$out = $sink->captured[0];
		$this->assertStringContainsString( 'a.com,b.com', $out[ Message::VALUE ]['arguments'] );
	}

	public function test_fill_drops_unregistered_option(): void {
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'never_registered' ];
		$node->fill( $msg );

		$this->assertCount( 0, $sink->captured );
	}

	public function test_fill_honors_value_resolver_filter(): void {
		\update_option( 'newspack_nodes_num_segments', 8 );
		$filter = static fn ( $value, $option ) => 'newspack_nodes_num_segments' === $option ? 99 : $value;
		\add_filter( 'newspack_nodes/settings_sync/value', $filter, 10, 2 );

		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( 'newspack_nodes_num_segments settings newspack_nodes_num_segments' );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_STRUCT;
		$msg[ Message::VALUE ] = [ 'option' => 'newspack_nodes_num_segments' ];
		$node->fill( $msg );

		\remove_action( 'newspack_nodes/settings_sync/value', $filter );

		$out = $sink->captured[0];
		$this->assertSame( 'newspack_nodes_num_segments 99', $out[ Message::VALUE ]['arguments'] );
	}

	public function test_fill_ignores_non_struct_message(): void {
		\update_option( 'newspack_nodes_num_segments', 8 );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( 'newspack_nodes_num_segments settings newspack_nodes_num_segments' );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = [ 'option' => 'newspack_nodes_num_segments' ];
		$node->fill( $msg );

		$this->assertCount( 0, $sink->captured );
	}

	public function test_fire_pushes_every_registered_option_in_one_call(): void {
		\update_option( 'newspack_nodes_num_segments', 8 );
		\update_option( 'newspack_nodes_num_partitions', 4 );
		$sink = new Capture_Sink_Node();
		$node = $this->wired_node( $sink );
		$node->add_setting( 'newspack_nodes_num_segments settings newspack_nodes_num_segments' );
		$node->add_setting( 'newspack_nodes_num_partitions settings newspack_nodes_num_partitions' );

		$node->fire();

		$this->assertCount( 2, $sink->captured );
		foreach ( $sink->captured as $out ) {
			$this->assertSame( 'set', $out[ Message::VALUE ]['name'] );
		}
	}

	public function test_arguments_arms_recurring_timer(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$node->arguments( '300' );

		$ref = new \ReflectionObject( $node );
		$this->assertSame( 300000, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
		$this->assertGreaterThan( 0.0, $node->next_fire );
		$mode = $ref->getProperty( 'mode' );
		$this->assertSame( 'event_framework', $mode->getValue( $node ) );
	}

	public function test_arguments_blank_arms_default_cadence(): void {
		$node = new Settings_Sync_Node();
		$node->name( 'settings-sync' );

		$node->arguments( '' );

		$this->assertSame( 300000, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
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
