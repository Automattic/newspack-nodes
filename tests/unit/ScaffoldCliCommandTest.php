<?php
/**
 * Tests for `wp nodes scaffold <plugin|node|topology> <name>` — first-contact
 * file generation matching the docs/writing-a-plugin.md canonical shapes.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Scaffold_CLI_Command;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

require_once \dirname( __DIR__, 2 ) . '/includes/cli/class-scaffold-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( Scaffold_CLI_Command::class )]
class ScaffoldCliCommandTest extends TestCase {
	private string $tmp;
	private string $original_cwd;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp          = $this->make_temp_dir( 'newspack-nodes-scaffold-test-' );
		$this->original_cwd = (string) \getcwd();
		\chdir( $this->tmp );

		$GLOBALS['_test_wp_cli_logs']    = [];
		$GLOBALS['_test_wp_cli_warns']   = [];
		$GLOBALS['_test_wp_cli_errors']  = [];
		$GLOBALS['_test_wp_cli_success'] = [];
	}

	protected function tearDown(): void {
		\chdir( $this->original_cwd );
		parent::tearDown();
	}

	private function scaffold( string $what, string $name ): void {
		( new Scaffold_CLI_Command() )->scaffold( [ $what, $name ], [] );
	}

	// -------------------------------------------------------------------------
	// plugin
	// -------------------------------------------------------------------------

	public function test_plugin_scaffold_creates_the_five_files(): void {
		$this->scaffold( 'plugin', 'orbit-mail' );

		$this->assertFileExists( "{$this->tmp}/orbit-mail/orbit-mail.php" );
		$this->assertFileExists( "{$this->tmp}/orbit-mail/composer.json" );
		$this->assertFileExists( "{$this->tmp}/orbit-mail/includes/class-orbit-mail-node.php" );
		$this->assertFileExists( "{$this->tmp}/orbit-mail/topologies/orbit-mail.tsl" );
		$this->assertFileExists( "{$this->tmp}/orbit-mail/README.md" );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
	}

	public function test_plugin_bootstrap_registers_the_derived_namespace(): void {
		$this->scaffold( 'plugin', 'orbit-mail' );

		$php = (string) \file_get_contents( "{$this->tmp}/orbit-mail/orbit-mail.php" );
		$this->assertStringContainsString( 'namespace Orbit_Mail;', $php );
		$this->assertStringContainsString( 'Topology_Registry::register_plugin', $php );
		$this->assertStringContainsString( "'Orbit_Mail\\\\'", $php );
		$this->assertStringContainsString( 'Requires Plugins: newspack-nodes', $php );
		$this->assertStringContainsString( "/vendor/autoload.php'", $php );
	}

	public function test_plugin_composer_json_uses_classmap_autoload(): void {
		$this->scaffold( 'plugin', 'orbit-mail' );

		$composer = \json_decode(
			(string) \file_get_contents( "{$this->tmp}/orbit-mail/composer.json" ),
			true
		);
		$this->assertIsArray( $composer );
		$this->assertSame( [ 'includes/' ], $composer['autoload']['classmap'] );
	}

	public function test_plugin_node_class_has_the_contract_surface(): void {
		$this->scaffold( 'plugin', 'orbit-mail' );

		$php = (string) \file_get_contents( "{$this->tmp}/orbit-mail/includes/class-orbit-mail-node.php" );
		$this->assertStringContainsString( 'namespace Orbit_Mail;', $php );
		$this->assertStringContainsString( 'class Orbit_Mail_Node extends Node', $php );
		$this->assertStringContainsString( 'public function fill( array $message ): void', $php );
		$this->assertStringContainsString( 'public function arguments( ?array $args = null ): array', $php );
		$this->assertStringContainsString( 'public static function node_schema(): array', $php );
		$this->assertStringContainsString( 'parent::fill(', $php );
	}

	public function test_plugin_topology_wires_the_node(): void {
		$this->scaffold( 'plugin', 'orbit-mail' );

		$tsl = (string) \file_get_contents( "{$this->tmp}/orbit-mail/topologies/orbit-mail.tsl" );
		$this->assertStringContainsString( 'var num_partitions = 1', $tsl );
		$this->assertStringContainsString( 'make_node Orbit_Mail orbit-mail', $tsl );
		$this->assertStringContainsString( 'connect_node orbit-mail', $tsl );
	}

	public function test_plugin_readme_names_the_next_step(): void {
		$this->scaffold( 'plugin', 'orbit-mail' );

		$readme = (string) \file_get_contents( "{$this->tmp}/orbit-mail/README.md" );
		$this->assertStringContainsString( 'composer dump-autoload -o', $readme );
	}

	public function test_plugin_refuses_to_overwrite_and_names_the_file(): void {
		\mkdir( "{$this->tmp}/orbit-mail", 0755, true );
		\file_put_contents( "{$this->tmp}/orbit-mail/orbit-mail.php", "<?php // precious\n" );

		try {
			$this->scaffold( 'plugin', 'orbit-mail' );
			$this->fail( 'Expected WP_CLI::error on existing target.' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'orbit-mail/orbit-mail.php', $e->getMessage() );
		}
		$this->assertSame( "<?php // precious\n", \file_get_contents( "{$this->tmp}/orbit-mail/orbit-mail.php" ) );
	}

	public function test_plugin_rejects_invalid_slug(): void {
		$this->expectException( \RuntimeException::class );
		$this->scaffold( 'plugin', 'Bad_Slug!' );
	}

	// -------------------------------------------------------------------------
	// node
	// -------------------------------------------------------------------------

	public function test_node_scaffold_writes_into_the_cwd(): void {
		$plugin_dir = "{$this->tmp}/orbit-mail";
		\mkdir( $plugin_dir, 0755, true );
		\chdir( $plugin_dir );

		$this->scaffold( 'node', 'Fancy_Filter' );

		// Drops the file where you are; `scaffold plugin` is what builds a tree.
		$file = "{$plugin_dir}/class-fancy-filter-node.php";
		$this->assertFileExists( $file );
		$php = (string) \file_get_contents( $file );
		$this->assertStringContainsString( 'namespace Orbit_Mail;', $php );
		$this->assertStringContainsString( 'class Fancy_Filter_Node extends Node', $php );
		$this->assertStringContainsString( 'public function fill( array $message ): void', $php );
	}

	public function test_node_scaffold_strips_a_given_node_suffix(): void {
		$this->scaffold( 'node', 'Fancy_Filter_Node' );

		$php = (string) \file_get_contents( "{$this->tmp}/class-fancy-filter-node.php" );
		$this->assertStringContainsString( 'class Fancy_Filter_Node extends Node', $php );
		$this->assertStringNotContainsString( 'Fancy_Filter_Node_Node', $php );
	}

	public function test_node_rejects_invalid_class_name(): void {
		$this->expectException( \RuntimeException::class );
		$this->scaffold( 'node', 'Fancy-Filter' );
	}

	public function test_node_refuses_to_overwrite(): void {
		\file_put_contents( "{$this->tmp}/class-fancy-filter-node.php", "<?php // precious\n" );

		try {
			$this->scaffold( 'node', 'Fancy_Filter' );
			$this->fail( 'Expected WP_CLI::error on existing target.' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'class-fancy-filter-node.php', $e->getMessage() );
		}
	}

	// -------------------------------------------------------------------------
	// topology
	// -------------------------------------------------------------------------

	public function test_topology_scaffold_writes_a_working_stock_graph(): void {
		$this->scaffold( 'topology', 'nightly-sync' );

		$file = "{$this->tmp}/nightly-sync.tsl";
		$this->assertFileExists( $file );
		$tsl = (string) \file_get_contents( $file );
		$this->assertStringContainsString( 'var num_partitions = 1', $tsl );
		$this->assertStringContainsString( 'make_node', $tsl );
		$this->assertStringContainsString( 'connect_node', $tsl );
	}

	public function test_topology_rejects_invalid_name(): void {
		$this->expectException( \RuntimeException::class );
		$this->scaffold( 'topology', 'Nightly Sync' );
	}

	// -------------------------------------------------------------------------
	// dispatch
	// -------------------------------------------------------------------------

	public function test_unknown_target_errors(): void {
		$this->expectException( \RuntimeException::class );
		$this->scaffold( 'gizmo', 'orbit-mail' );
	}

	public function test_missing_arguments_error(): void {
		$this->expectException( \RuntimeException::class );
		( new Scaffold_CLI_Command() )->scaffold( [], [] );
	}

	public function test_next_steps_are_printed(): void {
		$this->scaffold( 'plugin', 'orbit-mail' );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'composer dump-autoload -o', $haystack );
		$this->assertStringContainsString( 'wp nodes status', $haystack );
	}
}
