<?php
/**
 * SettingsCITest: unit tests for Settings_CI, the substrate service-CI that
 * replaces the legacy SettingsController.
 *
 * Asserts value-equivalence with the legacy `update_setting` writer for the
 * seven substrate-owned integer keys (num_partitions, segment_size,
 * min_segments, num_segments, min_lifetime, lifetime, max_segments), plus the additive
 * `get` verb that returns the same surface as a snapshot. Substrate config is seeded via
 * `TestCase::use_base_dir()`, mirroring StatusCITest / AggregatorCITest.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Rest\Settings_CI_Node;
use Newspack_Nodes\Rest\Classes_CI_Node;
use Newspack_Nodes\Settings_Event_Writer;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Settings_CI_Node::class )]
class SettingsCITest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		// /tmp directly to dodge symlink-resolved sys_get_temp_dir on macOS,
		// matching StatusCITest / AggregatorCITest.
		$this->tmp = (string) \realpath( \sys_get_temp_dir() ) . '/settings-ci-test-' . \uniqid();
		\mkdir( $this->tmp, 0755, true );
		$this->use_base_dir( $this->tmp );
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
	}

	protected function tearDown(): void {
		VerbHarness::reset();
		Settings_Event_Writer::$append_seam = null;
		unset( $GLOBALS['_wp_actions'][ \Newspack_Nodes\Config::RESET_ACTION ] );
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_get_verb_returns_current_settings_from_wp_options(): void {
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 8;
		$GLOBALS['_wp_options']['newspack_nodes_max_segments']   = 4;
		$GLOBALS['_wp_options']['newspack_nodes_segment_size']   = 65536;
		$GLOBALS['_wp_options']['newspack_nodes_min_lifetime']   = 86400;
		\Newspack_Nodes\Config::reset();

		$interpreter     = new Settings_CI_Node();
		$result = VerbHarness::fire( $interpreter, 'settings', 'get' );

		$this->assertIsArray( $result );
		$this->assertSame( 8, $result['num_partitions'] );
		$this->assertSame( 4, $result['max_segments'] );
		$this->assertSame( 65536, $result['segment_size'] );
		$this->assertSame( 86400, $result['min_lifetime'] );
	}

	public function test_get_verb_falls_through_to_defaults_when_options_unset(): void {
		// No WP options set — verb should still return a 7-key shape using
		// whatever the substrate Config defaults supply (driven by the
		// per-test base_dir config file). num_partitions defaults to 1 from
		// the substrate-config-defaults overlay.
		$interpreter     = new Settings_CI_Node();
		$result = VerbHarness::fire( $interpreter, 'settings', 'get' );

		$this->assertIsArray( $result );
		$this->assertArrayHasKey( 'num_partitions', $result );
		$this->assertArrayHasKey( 'min_segments', $result );
		$this->assertArrayHasKey( 'num_segments', $result );
		$this->assertArrayHasKey( 'segment_size', $result );
		$this->assertArrayHasKey( 'min_lifetime', $result );
		$this->assertArrayHasKey( 'lifetime', $result );
		$this->assertArrayHasKey( 'max_segments', $result );
		$this->assertIsInt( $result['num_partitions'] );
	}

	// ── set verb (normalized positional receiver) ──────────────────────────

	public function test_set_verb_applies_single_positional_int_setting(): void {
		$interpreter = new Settings_CI_Node();
		$result      = VerbHarness::fire(
			$interpreter,
			'settings',
			'set',
			'newspack_nodes_max_segments 8'
		);

		$this->assertIsArray( $result );
		$this->assertSame( 8, $result['max_segments'] );
		// int-sanitized write under the full option name.
		$this->assertSame( 8, $GLOBALS['_wp_options']['newspack_nodes_max_segments'] );
	}

	public function test_set_verb_rejects_unknown_option(): void {
		$interpreter = new Settings_CI_Node();
		$result      = VerbHarness::fire(
			$interpreter,
			'settings',
			'set',
			'newspack_nodes_not_in_allowlist 42'
		);
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'unknown setting', $result );
		$this->assertArrayNotHasKey( 'newspack_nodes_not_in_allowlist', $GLOBALS['_wp_options'] );
	}

	public function test_set_verb_accepts_the_short_name_without_the_option_prefix(): void {
		$interpreter = new Settings_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'settings', 'set', 'max_segments 9' );

		$this->assertIsArray( $result );
		$this->assertSame( 9, $result['max_segments'] );
		$this->assertSame( 9, $GLOBALS['_wp_options']['newspack_nodes_max_segments'] );
	}

	public function test_set_verb_rejects_a_value_outside_the_declared_bounds(): void {
		$interpreter = new Settings_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'settings', 'set', 'max_segments -3' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'invalid value for setting', $result );
		$this->assertArrayNotHasKey( 'newspack_nodes_max_segments', $GLOBALS['_wp_options'] );
	}

	// ── schema-driven dispatch ──────────────────────────────────────────────

	public function test_node_schema_lists_both_verbs_with_handlers(): void {
		$verbs = [];
		foreach ( Settings_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}

		$this->assertArrayHasKey( 'get', $verbs );
		$this->assertArrayHasKey( 'set', $verbs );
		$this->assertIsCallable( $verbs['get']['handler'] );
		$this->assertIsCallable( $verbs['set']['handler'] );
	}

	public function test_get_verb_declares_no_args(): void {
		// `get` reads no $payload/$args — it just returns the snapshot.
		$verbs = self::verbs_by_name();
		$this->assertSame( [], $verbs['get']['args'] );
	}

	public function test_set_verb_declares_required_option_and_value(): void {
		// `set` applies a single setting by full option name → both required:
		// option (string) + value (int). Inspector renders the two fields.
		$args = self::args_by_name( 'set' );

		$this->assertSame( [ 'option', 'value' ], \array_keys( $args ) );
		$this->assertSame( 'string', $args['option']['type'] );
		$this->assertTrue( $args['option']['required'] );
		$this->assertSame( 'int', $args['value']['type'] );
		$this->assertTrue( $args['value']['required'] );
	}

	/**
	 * Catalog-visibility guard (carried over from the ELN ServiceCiHandlerGuardTest
	 * when this CI moved here): a future edit dropping node_schema's `category` to
	 * ''/'Hidden' would silently hide Settings_CI from the Inspector/palette while
	 * every other test stayed green. Fire the substrate `classes list` and assert
	 * the CI surfaces under 'Service'.
	 */
	public function test_appears_in_class_catalog_as_service(): void {
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		$this->assertArrayHasKey( 'classes', $result );
		// A stale classmap (no composer dump-autoload -o) yields zero classes and
		// would pass the per-CI assertion vacuously. Fail loudly instead.
		$this->assertNotEmpty(
			$result['classes'],
			'class discovery found nothing — stale composer classmap? (run composer dump-autoload -o)'
		);

		$by_shell = [];
		foreach ( $result['classes'] as $entry ) {
			$by_shell[ $entry['shell_name'] ] = $entry['category'];
		}

		$this->assertArrayHasKey(
			'Settings_CI',
			$by_shell,
			"Settings_CI is absent from the class catalog — its node_schema category was dropped to ''/'Hidden', or class discovery is broken"
		);
		$this->assertSame( 'Service', $by_shell['Settings_CI'] );
	}

	/**
	 * node_schema()['commands'] indexed by verb name.
	 *
	 * @return array<string,array<string,mixed>>
	 */
	private static function verbs_by_name(): array {
		$verbs = [];
		foreach ( Settings_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}
		return $verbs;
	}

	/**
	 * A verb's args[] indexed by arg name.
	 *
	 * @param string $verb Verb name.
	 * @return array<string,array<string,mixed>>
	 */
	private static function args_by_name( string $verb ): array {
		$out = [];
		foreach ( self::verbs_by_name()[ $verb ]['args'] as $arg ) {
			$out[ $arg['name'] ] = $arg;
		}
		return $out;
	}
}
