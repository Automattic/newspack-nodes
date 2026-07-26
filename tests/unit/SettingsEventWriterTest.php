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
		// Filters registered via add_filter persist in $GLOBALS['_wp_actions'];
		// drop the allowlist filter so a test that extended it can't leak into
		// another test's allowlist decision.
		unset( $GLOBALS['_wp_actions']['newspack_nodes/settings_audit_values_allowlist'] );
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

	public function test_allowlist_defaults_to_settings_schema_option_names(): void {
		// A schema option (num_partitions) is on the default allowlist, so its
		// event carries old/new value excerpts — wp_json_encode of each side.
		Settings_Event_Writer::on_update( 'newspack_nodes_num_partitions', 'seven', 'eleven' );

		$this->assertSame(
			[ 'option' => 'newspack_nodes_num_partitions', 'old' => '"seven"', 'new' => '"eleven"' ],
			$this->captured[0][ Message::VALUE ]
		);
	}

	public function test_numeric_old_and_new_excerpt_the_same_regardless_of_php_type(): void {
		// A WP option round-tripped through the DB always reads back as a string
		// (`get_option()`'s $old); an int-typed Settings_Schema field's sanitizer
		// (`absint()`) hands `on_update()` a genuine PHP int as $new. Without
		// normalization the excerpts diverge on TYPE alone — `"900"` vs `900` —
		// even though the setting's actual VALUE never changed.
		Settings_Event_Writer::on_update( 'newspack_nodes_lifetime', '900', 900 );

		$this->assertSame(
			[ 'option' => 'newspack_nodes_lifetime', 'old' => '900', 'new' => '900' ],
			$this->captured[0][ Message::VALUE ]
		);
	}

	public function test_allowlisted_add_records_new_only(): void {
		Settings_Event_Writer::on_add( 'newspack_nodes_segment_size', 'freshsegment' );

		$value = $this->captured[0][ Message::VALUE ];
		$this->assertSame( 'newspack_nodes_segment_size', $value['option'] );
		$this->assertSame( '"freshsegment"', $value['new'] );
		$this->assertArrayNotHasKey( 'old', $value );
	}

	public function test_allowlisted_delete_records_old_fetched_via_get_option(): void {
		$GLOBALS['_wp_options']['newspack_nodes_lifetime'] = 'aboutToVanish';
		Settings_Event_Writer::on_delete( 'newspack_nodes_lifetime' );

		$value = $this->captured[0][ Message::VALUE ];
		$this->assertSame( '"aboutToVanish"', $value['old'] );
		$this->assertArrayNotHasKey( 'new', $value );
	}

	public function test_non_allowlisted_watched_option_stays_name_only(): void {
		// Watched (newspack_*) but not a substrate schema option: today's exact
		// byte-shape — the option name only, no old/new.
		Settings_Event_Writer::on_update( 'newspack_some_plugin_thing', 'a', 'b' );

		$this->assertSame(
			[ 'option' => 'newspack_some_plugin_thing' ],
			$this->captured[0][ Message::VALUE ]
		);
	}

	public function test_filter_can_extend_the_values_allowlist(): void {
		\add_filter(
			'newspack_nodes/settings_audit_values_allowlist',
			static function ( array $list ): array {
				$list[] = 'newspack_custom_addon_setting';
				return $list;
			}
		);
		Settings_Event_Writer::on_update( 'newspack_custom_addon_setting', 'before', 'after' );

		$value = $this->captured[0][ Message::VALUE ];
		$this->assertSame( '"before"', $value['old'] );
		$this->assertSame( '"after"', $value['new'] );
	}

	public function test_vault_option_never_records_values_even_if_filter_adds_it(): void {
		// Security invariant: the encrypted vault option is hard-excluded AFTER the
		// filter, so a filter trying to add it cannot leak its plaintext.
		\add_filter(
			'newspack_nodes/settings_audit_values_allowlist',
			static function ( array $list ): array {
				$list[] = 'newspack_nodes_vault';
				return $list;
			}
		);
		Settings_Event_Writer::on_update( 'newspack_nodes_vault', 'secret-old', 'secret-new' );

		$this->assertSame(
			[ 'option' => 'newspack_nodes_vault' ],
			$this->captured[0][ Message::VALUE ]
		);
	}

	public function test_multibyte_excerpts_are_halved_to_fit_the_pipe_buf_line(): void {
		// 300 emoji per side: each capped to ~200 chars, but each emoji JSON-packs
		// to a 12-byte surrogate pair, so the packed line blows past PIPE_BUF and the
		// halving loop trims both sides until it fits — without dropping the event.
		$big = \str_repeat( "\u{1F600}", 300 );
		Settings_Event_Writer::on_update( 'newspack_nodes_base_directory', $big, $big );

		$value = $this->captured[0][ Message::VALUE ];
		$this->assertArrayHasKey( 'old', $value, 'the trimmed excerpt survives — not dropped to name-only' );
		$this->assertArrayHasKey( 'new', $value );
		$this->assertNotSame( '', $value['old'] );
		$this->assertLessThan( 200, \mb_strlen( $value['old'] ), 'old excerpt trimmed below the char cap' );
		$this->assertLessThan( 200, \mb_strlen( $value['new'] ), 'new excerpt trimmed below the char cap' );
		$this->assertLessThan(
			Partition_Node::MAX_LINE_SIZE,
			Message::packed_size( $this->captured[0] ) + 1,
			'the packed line fits under PIPE_BUF'
		);
	}

	public function test_unfittable_record_drops_to_name_only_never_the_event(): void {
		// A pathological (filter-allowlisted) option name alone exceeds PIPE_BUF, so
		// no excerpt trimming can fit it: the writer drops to name-only rather than
		// dropping the change event entirely.
		$huge = 'newspack_' . \str_repeat( 'z', Partition_Node::MAX_LINE_SIZE );
		\add_filter(
			'newspack_nodes/settings_audit_values_allowlist',
			static function ( array $list ) use ( $huge ): array {
				$list[] = $huge;
				return $list;
			}
		);
		Settings_Event_Writer::on_update( $huge, 'x', 'y' );

		$this->assertCount( 1, $this->captured, 'the event is still emitted' );
		$this->assertSame( [ 'option' => $huge ], $this->captured[0][ Message::VALUE ] );
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

	public function test_writer_partition_args_declare_the_retention_axes(): void {
		// The settings log used to pass `2 86400` — a LIFETIME landing on the
		// num_segments slot, licensing 86400 segments. The count target is 2, the
		// day-long lifespan is the AGE rule; the hard cap derives to 2 × num_segments.
		$part = new Partition_Node();
		$part->arguments( Settings_Event_Writer::partition_args( $this->make_temp_dir() . '/settings.p0' ) );

		$this->assertSame( 2, $this->read_private( $part, 'min_segments' ) );
		$this->assertSame( 2, $this->read_private( $part, 'num_segments' ), 'a count target, not a duration' );
		$this->assertSame( 4, $this->read_private( $part, 'max_segments' ), 'hard cap derives to 2 × num_segments' );
		$this->assertSame( 0, $this->read_private( $part, 'min_lifetime' ) );
		$this->assertSame(
			Settings_Event_Writer::SETTINGS_LIFETIME,
			$this->read_private( $part, 'lifetime' ),
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
		$reader->arguments( [ Config::get_logs_directory() . '/settings.p0' ] );
		$values = $this->read_partition_values( $reader );
		$reader->remove_node();

		$this->assertSame(
			[ [ 'option' => 'newspack_first' ], [ 'option' => 'newspack_second' ] ],
			$values
		);
	}
	/**
	 * These hooks run on EVERY update_option on every request. A logs directory
	 * that cannot be created — a symlink, a foreign owner — makes
	 * Config::get_logs_directory() throw, and the throw escaped default_append()
	 * into whatever called update_option(). A settings-audit producer must never
	 * be able to fatal the caller it observes.
	 */
	public function test_a_logs_directory_failure_does_not_fatal_the_caller(): void {
		Settings_Event_Writer::$append_seam = null;
		// A symlinked `logs` leaf: ensure_path() refuses it, so
		// Config::get_logs_directory() throws inside default_append().
		$base = $this->make_temp_dir();
		$this->use_base_dir( $base );
		@\symlink( \sys_get_temp_dir(), $base . '/logs' );

		$writer = new \ReflectionMethod( Settings_Event_Writer::class, 'default_append' );
		$m      = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = [ 'option' => 'newspack_nodes_x' ];

		$writer->invoke( null, $m );

		$this->assertTrue( true, 'the throw is swallowed; reaching here is the assertion' );
	}

}
