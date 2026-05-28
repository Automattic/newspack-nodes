<?php
/**
 * TopologiesCITest: unit tests for Topologies_CI, the M3 service-CI that
 * replaces the legacy TopologiesController. Mirrors LayoutsCITest's
 * VerbHarness pattern and TopologiesControllerTest's per-test stock/user
 * directory fixture (Topology_Registry::register_stock_dir() +
 * set_user_dir() on temp dirs created in setUp).
 *
 * The CI returns raw payloads (decoded JSON) rather than the legacy
 * {code, message, status} envelopes. Errors bubble as RuntimeException;
 * CommandInterpreter::interpret() catches them and emits TM_COMMAND |
 * TM_ERROR. VerbHarness::fire() unwraps the success payload and
 * surfaces error payloads as plain strings, so tests assert "no
 * exception + decoded shape" on success and "string + message" on
 * failure.
 *
 * The list verb has both read and write callers; the spec says read
 * permission, so list does NOT require manage_options. save + delete
 * require manage_options. get requires read permission (manage_options
 * in legacy, but matching read of list).
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Rest\Topologies_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Topologies_CI_Node::class )]
class TopologiesCITest extends TestCase {

	private string $base_dir;
	private string $stock;
	private string $user;

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir( 'topologies-ci-' );
		// use_base_dir sets Config::load_config()['base_directory'] to
		// $base_dir so any CI default behavior referencing config picks
		// up the per-test sandbox.
		$this->use_base_dir( $this->base_dir );

		// Per-test stock + user dirs registered with Topology_Registry. The
		// CI reads through the registry; tests drop .tsl files into these
		// dirs to drive list/get/delete fixtures.
		$this->stock = $this->make_temp_dir( 'topologies-ci-stock-' );
		$this->user  = $this->make_temp_dir( 'topologies-ci-user-' );
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::set_user_dir( $this->user );

		// Verbs gate on manage_options for save/delete; allow it by default.
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_actions'] = [];
	}

	protected function tearDown(): void {
		VerbHarness::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->user );
		$this->rmdir_recursive( $this->base_dir );
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']                = [];
		// Restore env var to the bootstrap baseline so the next test's
		// Config doesn't point at our now-deleted per-test config file.
		\putenv(
			'LOCAL_NEWSPACK_NODES_CONF=' . \dirname( __DIR__ ) . '/newspack-nodes-test-config.php'
		);
		Config::reset();
		parent::tearDown();
	}

	// ── connect_worker_input verb ──────────────────────────────────────────────

	public function test_node_schema_declares_its_verbs(): void {
		$schema = Topologies_CI_Node::node_schema();
		$names  = \array_map( static fn ( array $v ): string => $v['name'], $schema['commands'] );
		\sort( $names );
		$this->assertSame(
			[ 'connect_worker_input', 'delete', 'get', 'list', 'save' ],
			$names
		);
		$this->assertNotEmpty( $schema['description'] );
	}

	public function test_connect_worker_input_mounts_only_the_named_worker(): void {
		// Two live workers (lock dir + ipc input dir); we connect only one.
		\mkdir( "{$this->base_dir}/locks/firehose-workers.p0.lock.d", 0755, true );
		\mkdir( "{$this->base_dir}/ipc/firehose-workers.p0/input", 0755, true );
		\mkdir( "{$this->base_dir}/locks/firehose-workers.p1.lock.d", 0755, true );
		\mkdir( "{$this->base_dir}/ipc/firehose-workers.p1/input", 0755, true );

		// connect_worker_input returns '' (no reply), so call dispatch directly
		// rather than VerbHarness::fire, which requires a response payload. The
		// reader id rides as the command argument.
		$result = ( new Topologies_CI_Node() )->dispatch( 'connect_worker_input', 'firehose-workers.p0' );

		$this->assertSame( '', $result, 'connect_worker_input must not emit a reply' );
		// The named worker's input Partition is now a node in the request graph,
		// so a pivoted command (TO=`firehose-workers.p0`) in the same /command
		// batch resolves and writes to the worker — instead of NOT_AVAILABLE.
		$this->assertInstanceOf(
			\Newspack_Nodes\Partition_Node::class,
			\Newspack_Nodes\Core::node( 'firehose-workers.p0' ),
			'connect_worker_input must mount the named worker input Partition'
		);
		// The other live worker is NOT mounted — we mount only what we're told.
		$this->assertNull(
			\Newspack_Nodes\Core::node( 'firehose-workers.p1' ),
			'connect_worker_input must mount only the named worker, not every live worker'
		);
	}

	// ── list verb ────────────────────────────────────────────────────────────

	public function test_list_returns_empty_when_no_topologies(): void {
		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'list' );

		$this->assertIsArray( $result );
		$this->assertSame( [], $result['topologies'] );
		$this->assertSame( $this->user, $result['user_dir'] );
	}

	public function test_list_returns_stock_topology_with_source_stock(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'list' );

		$this->assertCount( 1, $result['topologies'] );
		$entry = $result['topologies'][0];
		$this->assertSame( 'alpha', $entry['name'] );
		$this->assertSame( 'stock', $entry['source'] );
		$this->assertFalse( $entry['active'] );
		$this->assertIsArray( $entry['frontmatter'] );
	}

	public function test_list_returns_user_topology_with_source_user(): void {
		\file_put_contents( "{$this->user}/beta.tsl", "make_node Echo b\n" );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'list' );

		$this->assertCount( 1, $result['topologies'] );
		$this->assertSame( 'user', $result['topologies'][0]['source'] );
	}

	public function test_list_returns_both_when_user_shadows_stock(): void {
		\file_put_contents( "{$this->stock}/dual.tsl", "make_node Echo s\n" );
		\file_put_contents( "{$this->user}/dual.tsl",  "make_node Echo u\n" );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'list' );

		$this->assertSame( 'both', $result['topologies'][0]['source'] );
	}

	public function test_list_sorts_alphabetically(): void {
		\file_put_contents( "{$this->stock}/zeta.tsl",  "" );
		\file_put_contents( "{$this->stock}/alpha.tsl", "" );
		\file_put_contents( "{$this->stock}/middle.tsl", "" );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'list' );
		$names  = \array_column( $result['topologies'], 'name' );

		$this->assertSame( [ 'alpha', 'middle', 'zeta' ], $names );
	}

	public function test_list_marks_active_via_topologies_filter(): void {
		\file_put_contents( "{$this->stock}/active-one.tsl", "" );
		\file_put_contents( "{$this->stock}/inactive.tsl",   "" );
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ): array {
				$topologies['active-one'] = [
					'topology'       => 'active-one',
					'num_partitions' => 1,
					'stale_timeout'  => 60,
				];
				return $topologies;
			}
		);
		// `active` is derived from the operator overlay, not catalog membership.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'active-one' ];
		Config::reset();

		try {
			$result  = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'list' );
			$by_name = \array_column( $result['topologies'], null, 'name' );

			$this->assertTrue( $by_name['active-one']['active'] );
			$this->assertFalse( $by_name['inactive']['active'] );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
			Config::reset();
		}
	}

	public function test_list_includes_frontmatter_from_tsl(): void {
		\file_put_contents(
			"{$this->stock}/with-vars.tsl",
			"var num_partitions = 4\nvar stale_timeout = 120\nmake_node Echo e\n"
		);

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'list' );
		$entry  = $result['topologies'][0];

		$this->assertSame( 'with-vars', $entry['name'] );
		$this->assertSame( '4',   $entry['frontmatter']['num_partitions'] );
		$this->assertSame( '120', $entry['frontmatter']['stale_timeout'] );
	}

	// ── get verb ─────────────────────────────────────────────────────────────

	public function test_get_returns_tsl_body_with_source_stock(): void {
		\file_put_contents( "{$this->stock}/some-topology.tsl", "make_node Echo e\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'get',
			null,
			'some-topology'
		);

		$this->assertSame( 'some-topology', $result['name'] );
		$this->assertSame( 'stock', $result['source'] );
		$this->assertSame( "make_node Echo e\n", $result['tsl'] );
	}

	public function test_get_returns_user_body_when_user_shadows_stock(): void {
		\file_put_contents( "{$this->stock}/dual.tsl", "make_node Echo stock\n" );
		\file_put_contents( "{$this->user}/dual.tsl",  "make_node Echo user\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'get',
			null,
			'dual'
		);

		$this->assertSame( 'both', $result['source'] );
		$this->assertSame( "make_node Echo user\n", $result['tsl'] );
	}

	public function test_get_rejects_unknown_topology(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'get',
			null,
			'does-not-exist'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'no topology named', $result );
		$this->assertStringContainsString( 'does-not-exist', $result );
	}

	public function test_get_rejects_invalid_name(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'get',
			null,
			'../etc/passwd'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'invalid name', $result );
	}

	// ── save verb ────────────────────────────────────────────────────────────

	public function test_save_writes_tsl_file_under_user_dir(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[
					'name' => 'fresh',
					'tsl'  => "make_node Echo e\n",
				]
		);

		$this->assertSame( 'fresh', $result['name'] );
		$this->assertSame( "{$this->user}/fresh.tsl", $result['path'] );
		$this->assertFalse( $result['shadows_stock'] );
		$this->assertSame( [], $result['restarted_fleets'] );
		$this->assertSame(
			"make_node Echo e\n",
			\file_get_contents( "{$this->user}/fresh.tsl" )
		);
	}

	public function test_save_then_get_round_trips(): void {
		VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[
					'name' => 'roundtrip',
					'tsl'  => "make_node Tee t\nmake_node Echo e\n",
				]
		);
		VerbHarness::reset();

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'get',
			null,
			'roundtrip'
		);

		$this->assertSame( 'user', $result['source'] );
		$this->assertSame( "make_node Tee t\nmake_node Echo e\n", $result['tsl'] );
	}

	public function test_save_reports_shadows_stock_when_stock_copy_exists(): void {
		\file_put_contents( "{$this->stock}/shadowing.tsl", "make_node Echo s\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[
					'name' => 'shadowing',
					'tsl'  => "make_node Echo u\n",
				]
		);

		$this->assertTrue( $result['shadows_stock'] );
	}

	public function test_save_rejects_invalid_tsl_with_line_number(): void {
		// Line 3 ends with a trailing backslash — a structural error
		// Shell::validate_line throws on. The CI must report the line index
		// (1-based) so the editor can position the cursor. (Unknown verbs are NOT
		// a save-time error — they surface at runtime as `unknown command`.)
		$tsl = "make_node Echo e\nmake_node Tee t\nmake_node Echo x\\\n";

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[
					'name' => 'bad-verb',
					'tsl'  => $tsl,
				]
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'validation failed', $result );
		$this->assertStringContainsString( 'line 3', $result );
		$this->assertStringContainsString( 'backslash continuation', $result );
	}

	public function test_save_rejects_body_too_large(): void {
		// Build a JSON envelope whose tsl string puts the total args size
		// just over 64 KiB. Pad inside a single comment line so it's still
		// structurally valid TSL when it would land.
		$prefix  = '{"name":"big","tsl":"#';
		$suffix  = '"}';
		$padding = \str_repeat( 'x', 65537 - \strlen( $prefix ) - \strlen( $suffix ) );
		$args    = $prefix . $padding . $suffix;
		$this->assertSame( 65537, \strlen( $args ) );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'save', $args );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'too large', $result );
	}

	public function test_save_rejects_invalid_name(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[
					'name' => 'bad.name',
					'tsl'  => "make_node Echo e\n",
				]
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'invalid name', $result );
	}

	public function test_save_rejects_missing_tsl(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'name' => 'no-body' ]
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'tsl', $result );
	}

	public function test_save_requires_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[
					'name' => 'nope',
					'tsl'  => "make_node Echo e\n",
				]
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	public function test_save_fires_restart_fleet_for_active_topology(): void {
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ): array {
				$topologies['active-one'] = [
					'topology'       => 'active-one',
					'num_partitions' => 1,
					'stale_timeout'  => 60,
				];
				return $topologies;
			}
		);
		$fired = [];
		\add_action(
			'newspack_nodes/restart_fleet',
			static function ( string $name ) use ( &$fired ): void {
				$fired[] = $name;
			}
		);

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[
					'name' => 'active-one',
					'tsl'  => "make_node Echo e\n",
				]
		);

		$this->assertSame( [ 'active-one' ], $result['restarted_fleets'] );
		$this->assertSame( [ 'active-one' ], $fired );
	}

	public function test_save_does_not_fire_restart_for_inactive_topology(): void {
		$fired = [];
		\add_action(
			'newspack_nodes/restart_fleet',
			static function ( string $name ) use ( &$fired ): void {
				$fired[] = $name;
			}
		);

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[
					'name' => 'dormant',
					'tsl'  => "make_node Echo e\n",
				]
		);

		$this->assertSame( [], $result['restarted_fleets'] );
		$this->assertSame( [], $fired );
	}

	public function test_save_creates_user_dir_when_missing(): void {
		$nested = $this->user . '/nested/deeper';
		Topology_Registry::set_user_dir( $nested );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[
					'name' => 'auto-mkdir',
					'tsl'  => "make_node Echo e\n",
				]
		);

		$this->assertDirectoryExists( $nested );
		$this->assertFileExists( $nested . '/auto-mkdir.tsl' );
		$this->assertSame( $nested . '/auto-mkdir.tsl', $result['path'] );
	}

	// ── delete verb ──────────────────────────────────────────────────────────

	public function test_delete_removes_user_file_and_returns_path(): void {
		$path = "{$this->user}/to-delete.tsl";
		\file_put_contents( $path, "make_node Echo e\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			null,
			'to-delete'
		);

		$this->assertSame( 'to-delete', $result['name'] );
		$this->assertSame( $path, $result['deleted'] );
		$this->assertFalse( $result['stock_fallback'] );
		$this->assertFileDoesNotExist( $path );
	}

	public function test_delete_reports_stock_fallback_true_when_stock_copy_exists(): void {
		\file_put_contents( "{$this->stock}/shadowed.tsl", "make_node Echo s\n" );
		\file_put_contents( "{$this->user}/shadowed.tsl",  "make_node Echo u\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			null,
			'shadowed'
		);

		$this->assertTrue( $result['stock_fallback'] );
	}

	public function test_delete_fires_restart_fleet_for_active_topology(): void {
		// Symmetry with save: deleting a user override that shadows a stock copy
		// must restart the fleet so the worker reloads the stock version.
		\file_put_contents( "{$this->stock}/shadowed.tsl", "make_node Echo s\n" );
		\file_put_contents( "{$this->user}/shadowed.tsl",  "make_node Echo u\n" );
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ): array {
				$topologies['shadowed'] = [
					'topology'       => 'shadowed',
					'num_partitions' => 1,
					'stale_timeout'  => 60,
				];
				return $topologies;
			}
		);
		$fired = [];
		\add_action(
			'newspack_nodes/restart_fleet',
			static function ( string $name ) use ( &$fired ): void {
				$fired[] = $name;
			}
		);

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			null,
			'shadowed'
		);

		$this->assertSame( [ 'shadowed' ], $result['restarted_fleets'] );
		$this->assertSame( [ 'shadowed' ], $fired );
	}

	public function test_delete_does_not_fire_restart_for_inactive_topology(): void {
		\file_put_contents( "{$this->user}/dormant.tsl", "make_node Echo e\n" );
		$fired = [];
		\add_action(
			'newspack_nodes/restart_fleet',
			static function ( string $name ) use ( &$fired ): void {
				$fired[] = $name;
			}
		);

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			null,
			'dormant'
		);

		$this->assertSame( [], $result['restarted_fleets'] );
		$this->assertSame( [], $fired );
	}

	public function test_delete_rejects_when_no_user_file_exists(): void {
		// Stock copy present, but no user file — delete is illegal because
		// stock topologies are immutable.
		\file_put_contents( "{$this->stock}/stock-only.tsl", "make_node Echo e\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			null,
			'stock-only'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'no user-saved topology', $result );
	}

	public function test_delete_rejects_invalid_name(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			null,
			'../bad'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'invalid name', $result );
	}

	public function test_delete_requires_manage_options(): void {
		\file_put_contents( "{$this->user}/locked.tsl", "make_node Echo e\n" );
		$GLOBALS['_wp_test_current_user_can'] = [];

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			null,
			'locked'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
		// File must still exist — permission check prevents the unlink.
		$this->assertFileExists( "{$this->user}/locked.tsl" );
	}
}
