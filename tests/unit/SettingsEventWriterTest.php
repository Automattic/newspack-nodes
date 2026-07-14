<?php
/**
 * Tests for Settings_Event_Writer — the option-name-only atomic append producer.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Settings_Event_Writer;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;

#[\PHPUnit\Framework\Attributes\CoversClass( Settings_Event_Writer::class )]
class SettingsEventWriterTest extends TestCase {

	/** @var array<int,array<int,mixed>> Messages captured by the test seam. */
	private array $captured = [];

	protected function setUp(): void {
		parent::setUp();
		$this->captured              = [];
		Settings_Event_Writer::$append_seam = function ( array $m ): void {
			$this->captured[] = $m;
		};
	}

	protected function tearDown(): void {
		Settings_Event_Writer::$append_seam = null;
		parent::tearDown();
	}

	public function test_watched_option_update_emits_name_only_struct_event(): void {
		Settings_Event_Writer::on_update( 'newspack_some_setting', 'old', 'new' );

		$this->assertCount( 1, $this->captured );
		$message = $this->captured[0];
		$this->assertSame( Message::TM_STRUCT, $message[ Message::TYPE ] );
		$this->assertSame( [ 'option' => 'newspack_some_setting' ], $message[ Message::VALUE ] );
		$this->assertArrayNotHasKey( 'value', $message[ Message::VALUE ] );
	}

	public function test_watched_option_add_emits_event(): void {
		Settings_Event_Writer::on_add( 'newspack_added', 'whatever' );

		$this->assertCount( 1, $this->captured );
		$this->assertSame( [ 'option' => 'newspack_added' ], $this->captured[0][ Message::VALUE ] );
	}

	public function test_watched_option_delete_emits_event(): void {
		// Resetting a setting to its default deletes the option row (Reset_Gate),
		// which fires delete_option — the reset must still propagate to spokes.
		Settings_Event_Writer::on_delete( 'newspack_reset_to_default' );

		$this->assertCount( 1, $this->captured );
		$this->assertSame( [ 'option' => 'newspack_reset_to_default' ], $this->captured[0][ Message::VALUE ] );
	}

	public function test_non_watched_option_emits_nothing(): void {
		Settings_Event_Writer::on_update( 'blogname', 'old', 'new' );
		Settings_Event_Writer::on_add( 'siteurl', 'http://example.test' );

		$this->assertCount( 0, $this->captured );
	}

	public function test_init_wires_update_and_add_option_hooks(): void {
		$GLOBALS['_wp_actions'] = [];
		// init() is idempotent and the suite bootstrap already ran it, so reset
		// the guard to exercise the real hook-wiring here.
		$initialized = new \ReflectionProperty( Settings_Event_Writer::class, 'initialized' );
		$initialized->setValue( null, false );
		Settings_Event_Writer::init();

		\do_action( 'update_option', 'newspack_via_hook', 'old', 'new' );
		\do_action( 'add_option', 'newspack_added_via_hook', 'value' );
		\do_action( 'delete_option', 'newspack_deleted_via_hook' );

		$this->assertCount( 3, $this->captured );
		$this->assertSame( [ 'option' => 'newspack_via_hook' ], $this->captured[0][ Message::VALUE ] );
		$this->assertSame( [ 'option' => 'newspack_added_via_hook' ], $this->captured[1][ Message::VALUE ] );
		$this->assertSame( [ 'option' => 'newspack_deleted_via_hook' ], $this->captured[2][ Message::VALUE ] );
	}

	public function test_writer_partition_args_declare_all_four_retention_axes(): void {
		// The settings log used to pass `2 86400` — a LIFETIME landing on the
		// max_segments slot, licensing 86400 segments. All four axes, explicitly.
		$part = new Partition_Node();
		$part->arguments( Settings_Event_Writer::partition_args( '/tmp/settings.p0' ) );

		$this->assertSame( 2, $this->read_private( $part, 'min_segments' ) );
		$this->assertSame( 2, $this->read_private( $part, 'max_segments' ), 'a count, not a duration' );
		$this->assertSame( 0, $this->read_private( $part, 'min_lifetime' ) );
		$this->assertSame(
			Settings_Event_Writer::SETTINGS_MAX_LIFETIME,
			$this->read_private( $part, 'max_lifetime' ),
			'the day-long lifespan is the AGE rule'
		);
	}

	/**
	 * The critical test: drive the PRODUCTION default seam (no mock) twice in
	 * one request. Each write constructs a named `settings:writer` Partition and
	 * tears it down, so the Core registry never holds two colliding objects.
	 */
	public function test_two_writes_in_one_request_no_collision_and_persist(): void {
		Settings_Event_Writer::$append_seam = null;

		$dir = $this->make_temp_dir();
		$this->use_base_dir( $dir );

		Settings_Event_Writer::on_update( 'newspack_first', 'a', 'b' );
		Settings_Event_Writer::on_update( 'newspack_second', 'c', 'd' );

		$this->assertNull( Core::node( 'settings:writer' ), 'transient writer must be torn down after each fill' );
		$this->assertNull( Core::node( 'settings:writer:config' ), 'sibling :config interpreter must be torn down too' );

		$reader = new Partition_Node();
		$reader->name( 'settings:reader' );
		$reader->arguments( Config::get_logs_directory() . '/settings.p0' );
		$values = $this->read_partition_values( $reader );
		$reader->remove_node();

		$this->assertSame(
			[ [ 'option' => 'newspack_first' ], [ 'option' => 'newspack_second' ] ],
			$values
		);
	}
}
