<?php
/**
 * TopologiesCITest: unit tests for Topologies_CI, the M3 service-interpreter that
 * replaces the legacy TopologiesController. Mirrors LayoutsCITest's
 * VerbHarness pattern and TopologiesControllerTest's per-test stock/user
 * directory fixture (Topology_Registry::register_stock_dir() +
 * register_user_dir() on temp dirs created in setUp).
 *
 * The interpreter returns raw payloads (decoded JSON) rather than the legacy
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

	/** Read-only scratch dirs a test chmods 0500; tearDown restores 0700 and removes them (make_temp_dir does NOT auto-clean). */
	private array $readonly_dirs = [];

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir( 'topologies-ci-' );
		// use_base_dir sets Config::load_config()['base_directory'] to
		// $base_dir so any interpreter default behavior referencing config picks
		// up the per-test sandbox.
		$this->use_base_dir( $this->base_dir );

		// Per-test stock + user dirs registered with Topology_Registry. The
		// interpreter reads through the registry; tests drop .tsl files into these
		// dirs to drive list/get/delete fixtures.
		$this->stock = $this->make_temp_dir( 'topologies-ci-stock-' );
		$this->user  = $this->make_temp_dir( 'topologies-ci-user-' );
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );

		// Verbs gate on manage_options for save/delete; allow it by default.
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_actions'] = [];
	}

	protected function tearDown(): void {
		VerbHarness::reset();
		Topology_Registry::reset();
		// Restore perms before removing — a 0500 dir can't have its contents unlinked.
		foreach ( $this->readonly_dirs as $dir ) {
			\chmod( $dir, 0700 );
			$this->rmdir_recursive( $dir );
		}
		$this->readonly_dirs = [];
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->user );
		$this->rmdir_recursive( $this->base_dir );
		// Reset here too so an assertion failure mid-test can't leak it.
		unset( $GLOBALS['_test_outbound_posts'] );
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

	// ── schema + connect_worker_input verb ─────────────────────────────────────

	public function test_node_schema_declares_its_verbs(): void {
		$schema = Topologies_CI_Node::node_schema();
		$names  = \array_map( static fn ( array $v ): string => $v['name'], $schema['commands'] );
		\sort( $names );
		$this->assertSame(
			[ 'activate', 'connect_worker_input', 'deactivate', 'delete', 'expand', 'get', 'list', 'save' ],
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
		$result = ( new Topologies_CI_Node() )->dispatch( 'connect_worker_input', [ 'firehose-workers.p0' ] );

		$this->assertSame( '', $result, 'connect_worker_input must not emit a reply' );
		// The named worker's input Partition is now a node in the request graph,
		// so an attached command (TO=`firehose-workers.p0`) in the same /command
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

	public function test_list_is_denied_without_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'list' );

		$this->assertSame( 'permission denied: manage capability required', $result );
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

	public function test_list_includes_num_partitions_derived_from_frontmatter(): void {
		\file_put_contents(
			"{$this->stock}/with-vars.tsl",
			"var num_partitions = 4\nmake_node Echo e\n"
		);

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'list' );
		$entry  = $result['topologies'][0];

		// The Path menu needs a numeric partition count; the raw frontmatter
		// value is a string, so the entry carries a derived int alongside it.
		$this->assertSame( 4, $entry['num_partitions'] );
	}

	public function test_list_num_partitions_prefers_catalog_count(): void {
		\file_put_contents( "{$this->stock}/cat.tsl", '' );
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ): array {
				$topologies['cat'] = [
					'topology'       => 'cat',
					'num_partitions' => 3,
					'stale_timeout'  => 60,
				];
				return $topologies;
			}
		);

		$result  = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'list' );
		$by_name = \array_column( $result['topologies'], null, 'name' );

		$this->assertSame( 3, $by_name['cat']['num_partitions'] );
	}

	// ── get verb ─────────────────────────────────────────────────────────────

	public function test_get_returns_tsl_body_with_source_stock(): void {
		\file_put_contents( "{$this->stock}/some-topology.tsl", "make_node Echo e\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'get',
			'some-topology'
		);

		$this->assertSame( 'some-topology', $result['name'] );
		$this->assertSame( 'stock', $result['source'] );
		// cmd_get returns the topology body verbatim — the reserved `_repl` anchor
		// is injected editor-side (withReplAnchor), never baked into the response,
		// so it can't round-trip into a persisted .tsl.
		$this->assertSame(
			"make_node Echo e\n",
			$result['tsl']
		);
	}

	/**
	 * A user file no longer shadows stock, so `get` shows what actually RUNS —
	 * the stock body. `source` still reports both copies exist, because they do;
	 * a stale user file left over from before the precedence change is exactly
	 * what an operator needs to see.
	 */
	public function test_get_returns_the_stock_body_that_actually_runs(): void {
		\file_put_contents( "{$this->stock}/dual.tsl", "make_node Echo stock\n" );
		\file_put_contents( "{$this->user}/dual.tsl",  "make_node Echo user\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'get',
			'dual'
		);

		$this->assertSame( 'both', $result['source'] );
		$this->assertSame(
			"make_node Echo stock\n",
			$result['tsl']
		);
	}

	/**
	 * Refuse the write rather than accept a file resolution will ignore. Saving
	 * a stock name used to override it; now it would sit inert on disk while
	 * the editor reported success.
	 */
	public function test_save_refuses_a_name_a_stock_dir_already_provides(): void {
		\file_put_contents( "{$this->stock}/dual.tsl", "make_node Echo stock\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			'dual make_node Echo mine'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'a stock topology owns that name', $result );
		$this->assertFileDoesNotExist( "{$this->user}/dual.tsl" );
	}

	public function test_get_rejects_unknown_topology(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'get',
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
			[ 'fresh', "make_node Echo e\n" ]
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
			[ 'roundtrip', "make_node Tee t\nmake_node Echo e\n" ]
		);
		VerbHarness::reset();

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'get',
			'roundtrip'
		);

		$this->assertSame( 'user', $result['source'] );
		$this->assertSame(
			"make_node Tee t\nmake_node Echo e\n",
			$result['tsl']
		);
	}

	/** Nothing shadows any more: a save that lands is a name stock does not own. */
	public function test_save_never_reports_shadowing_stock(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'not-a-stock-name', "make_node Echo u\n" ]
		);

		$this->assertFalse( $result['shadows_stock'] );
	}

	/**
	 * The saved body's OWN make_node can collide with a borrowed one. Caught at
	 * save, not at boot: `make_node` throws on a conflicting redeclaration, so a
	 * body that saves clean here would kill the worker on its next spawn.
	 */
	public function test_save_rejects_a_node_that_conflicts_with_an_included_one(): void {
		\file_put_contents( "{$this->stock}/zebra-base.tsl", "make_node Tee shared-tee\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'clash-top', "include zebra-base\nmake_node Echo shared-tee\n" ]
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'validation failed', $result );
		$this->assertStringContainsString( 'shared-tee', $result );
	}

	/** An IDENTICAL redeclaration is legal — make_node collapses it. */
	public function test_save_accepts_a_node_declared_identically_by_an_include(): void {
		\file_put_contents( "{$this->stock}/zebra-base.tsl", "make_node Grep shared-grep giraffe-pattern\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'twin-top', "include zebra-base\nmake_node Grep shared-grep giraffe-pattern\n" ]
		);

		$this->assertIsArray( $result );
		$this->assertSame( 'twin-top', $result['name'] );
	}

	public function test_save_rejects_invalid_tsl_with_line_number(): void {
		// Line 3 ends with a trailing backslash — a structural error
		// Shell::validate_line throws on. The interpreter must report the line index
		// (1-based) so the editor can position the cursor. (Unknown verbs are NOT
		// a save-time error — they surface at runtime as `unknown command`.)
		$tsl = "make_node Echo e\nmake_node Tee t\nmake_node Echo x\\\n";

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'bad-verb', $tsl ]
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'validation failed', $result );
		$this->assertStringContainsString( 'line 3', $result );
		$this->assertStringContainsString( 'backslash continuation', $result );
	}

	public function test_save_rejects_body_too_large(): void {
		// Arguments just over 1 MiB: a `big` name plus a padded comment-line
		// body. The size guard measures the whole packed envelope and trips
		// before the body is parsed.
		$args = 'big ' . '# ' . \str_repeat( 'x', 1048577 );
		$this->assertGreaterThan( 1048576, \strlen( $args ) );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'save', $args );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'too large', $result );
	}

	public function test_save_accepts_large_body_under_one_mib(): void {
		// A real captured graph (hundreds of KiB of make_node lines) is well
		// over the old 64 KiB guard but under the 1 MiB cap — it must save.
		$body = '';
		for ( $i = 0; $i < 10000; $i++ ) {
			$body .= "make_node Tee t$i\n";
		}
		$this->assertGreaterThan( 65536, \strlen( $body ) );
		$this->assertLessThan( 1048576, \strlen( $body ) );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'save', [ 'big', $body ] );

		$this->assertIsArray( $result );
		$this->assertSame( 'big', $result['name'] );
		$this->assertSame( $body, \file_get_contents( "{$this->user}/big.tsl" ) );
	}

	public function test_save_rejects_invalid_name(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'bad.name', "make_node Echo e\n" ]
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'invalid name', $result );
	}

	public function test_save_rejects_missing_tsl(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			'no-body'
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
			[ 'nope', "make_node Echo e\n" ]
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
			[ 'active-one', "make_node Echo e\n" ]
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
			[ 'dormant', "make_node Echo e\n" ]
		);

		$this->assertSame( [], $result['restarted_fleets'] );
		$this->assertSame( [], $fired );
	}

	public function test_save_creates_user_dir_when_missing(): void {
		$nested = $this->user . '/nested/deeper';
		Topology_Registry::register_user_dir( $nested );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'auto-mkdir', "make_node Echo e\n" ]
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
			'to-delete'
		);

		$this->assertSame( 'to-delete', $result['name'] );
		$this->assertSame( $path, $result['deleted'] );
		$this->assertFalse( $result['stock_fallback'] );
		$this->assertFileDoesNotExist( $path );
	}

	public function test_delete_prunes_active_entry_when_no_stock_fallback(): void {
		// User-only topology, in the active set. After delete there is no stock
		// copy to fall back to, so a dangling active entry would be orphaned —
		// the delete must prune it from newspack_nodes_topologies.
		\file_put_contents( "{$this->user}/orphan.tsl", "make_node Echo e\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'orphan', 'other' ];

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			'orphan'
		);

		$this->assertFalse( $result['stock_fallback'] );
		$this->assertTrue( $result['pruned_active'] );
		$this->assertSame(
			[ 'other' ],
			$GLOBALS['_wp_options']['newspack_nodes_topologies']
		);
	}

	public function test_delete_keeps_active_entry_when_stock_fallback_exists(): void {
		// User copy shadows a stock copy, both active. Deleting the user copy
		// leaves the stock version resolving + running, so the active entry
		// must stay — pruning it would stop a topology that still exists.
		\file_put_contents( "{$this->stock}/shadowed.tsl", "make_node Echo s\n" );
		\file_put_contents( "{$this->user}/shadowed.tsl",  "make_node Echo u\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'shadowed' ];

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			'shadowed'
		);

		$this->assertTrue( $result['stock_fallback'] );
		$this->assertFalse( $result['pruned_active'] );
		$this->assertSame(
			[ 'shadowed' ],
			$GLOBALS['_wp_options']['newspack_nodes_topologies']
		);
	}

	public function test_delete_reports_stock_fallback_true_when_stock_copy_exists(): void {
		\file_put_contents( "{$this->stock}/shadowed.tsl", "make_node Echo s\n" );
		\file_put_contents( "{$this->user}/shadowed.tsl",  "make_node Echo u\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
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
			'../bad'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'invalid name', $result );
	}

	public function test_save_succeeds_without_arming_a_gc_flag(): void {
		// The GC now runs every supervisor config-check tick against the
		// config-declared set, so save no longer arms a dirty flag — it just
		// persists the topology.
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'armed', "make_node Partition p\n" ]
		);

		$this->assertSame( 'armed', $result['name'] );
		$this->assertFileExists( $result['path'] );
	}

	public function test_delete_succeeds_without_arming_a_gc_flag(): void {
		VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'to-remove', "make_node Partition p\n" ]
		);
		VerbHarness::reset();

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			'to-remove'
		);

		$this->assertSame( 'to-remove', $result['name'] );
		$this->assertStringEndsWith( 'to-remove.tsl', $result['deleted'] );
	}

	public function test_get_reports_read_failure_when_resolved_file_is_unreadable(): void {
		// resolve() succeeds (the file exists), but file_get_contents fails — the
		// verb surfaces a read-failure error rather than returning an empty body.
		$path = "{$this->stock}/unreadable.tsl";
		\file_put_contents( $path, "make_node Echo e\n" );
		\chmod( $path, 0000 );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'get', 'unreadable' );

		\chmod( $path, 0644 );
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'failed to read topology file', $result );
	}

	public function test_save_rejects_when_no_writable_user_dir(): void {
		Topology_Registry::register_user_dir( '' );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'orphan', "make_node Echo e\n" ]
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'no writable user dir', $result );
	}

	public function test_save_reports_mkdir_failure_when_user_dir_path_is_blocked(): void {
		// A regular file sits where a path segment of the user dir must be a
		// directory, so the recursive mkdir can't create it.
		$blocker = "{$this->base_dir}/blocker";
		\file_put_contents( $blocker, 'x' );
		Topology_Registry::register_user_dir( "{$blocker}/sub" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'fresh', "make_node Echo e\n" ]
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'failed to create user dir', $result );
	}

	public function test_save_reports_write_failure_into_readonly_user_dir(): void {
		$readonly              = $this->make_temp_dir( 'topologies-ci-readonly-' );
		$this->readonly_dirs[] = $readonly; // tearDown restores 0700 + removes it.
		Topology_Registry::register_user_dir( $readonly );
		\chmod( $readonly, 0500 );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'fresh', "make_node Echo e\n" ]
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'failed to write topology file', $result );
	}

	public function test_delete_rejects_when_no_user_dir_configured(): void {
		Topology_Registry::register_user_dir( '' );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'delete', 'whatever' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'no user dir configured', $result );
	}

	public function test_delete_reports_unlink_failure_when_user_dir_is_readonly(): void {
		// The file exists (is_file passes through the dir's r-x bits), but the
		// directory is read-only so the unlink can't remove it.
		$readonly = $this->make_temp_dir( 'topologies-ci-locked-' );
		\file_put_contents( "{$readonly}/stuck.tsl", "make_node Echo e\n" );
		$this->readonly_dirs[] = $readonly; // tearDown restores 0700 + removes it.
		Topology_Registry::register_user_dir( $readonly );
		\chmod( $readonly, 0500 );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'delete', 'stuck' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'failed to unlink topology file', $result );
	}

	// ── activate / deactivate verbs ────────────────────────────────────────────

	public function test_activate_adds_to_active_set_and_returns_spawn_count(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "var num_partitions = 2\nmake_node Echo e\n" );
		$GLOBALS['_test_outbound_posts'] = [];

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'activate', 'alpha' );

		$this->assertSame( 'alpha', $result['name'] );
		$this->assertTrue( $result['active'] );
		$this->assertSame( 2, $result['spawned'] );
		$this->assertContains( 'alpha', (array) \get_option( 'newspack_nodes_topologies', [] ) );
	}

	public function test_activate_rejects_unknown_topology(): void {
		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'activate', 'ghost' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'unknown topology', $result );
	}

	public function test_deactivate_removes_from_active_set(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo e\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'deactivate', 'alpha' );

		$this->assertSame( 'alpha', $result['name'] );
		$this->assertFalse( $result['active'] );
		$this->assertNotContains( 'alpha', (array) \get_option( 'newspack_nodes_topologies', [] ) );
	}

	public function test_delete_requires_manage_options(): void {
		\file_put_contents( "{$this->user}/locked.tsl", "make_node Echo e\n" );
		$GLOBALS['_wp_test_current_user_can'] = [];

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'delete',
			'locked'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
		// File must still exist — permission check prevents the unlink.
		$this->assertFileExists( "{$this->user}/locked.tsl" );
	}

	// ── expand verb + list includes ─────────────────────────────────────────

	public function test_expand_verb_returns_the_composed_graph_with_provenance(): void {
		\file_put_contents( "{$this->stock}/wombat-base.tsl", "make_node Tee shared-tee\n" );
		\file_put_contents( "{$this->stock}/wombat-top.tsl", "include wombat-base\nmake_node Echo top-echo\n" );

		$out = Topologies_CI_Node::cmd_expand( [ 'wombat-top' ] );

		$names = \array_column( $out['nodes'], 'name' );
		$this->assertContains( 'shared-tee', $names );
		$this->assertContains( 'top-echo', $names );
		$this->assertSame( [ 'wombat-top' => [ 'wombat-base' => [] ] ], $out['tree'] );
	}

	public function test_list_reports_each_topology_direct_includes(): void {
		\file_put_contents( "{$this->stock}/wombat-base.tsl", "make_node Tee shared-tee\n" );
		\file_put_contents( "{$this->stock}/wombat-top.tsl", "include wombat-base\nmake_node Echo top-echo\n" );

		$out    = Topologies_CI_Node::cmd_list();
		$byName = [];
		foreach ( $out['topologies'] as $entry ) {
			$byName[ $entry['name'] ] = $entry;
		}

		$this->assertSame( [ 'wombat-base' ], $byName['wombat-top']['includes'] );
		$this->assertSame( [], $byName['wombat-base']['includes'] );
	}

	public function test_expand_verb_throws_on_unknown_topology(): void {
		$this->expectException( \RuntimeException::class );
		Topologies_CI_Node::cmd_expand( [ 'no-such-topology' ] );
	}

	// ── save resolves includes ──────────────────────────────────────────────

	public function test_save_rejects_a_tsl_including_an_unknown_topology(): void {
		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'save',
			[ 'broken-include', "include no-such-topology\n" ]
		);

		$this->assertIsString( $result, 'save must reject an unresolvable include, not write it to disk' );
		$this->assertStringContainsString( 'no-such-topology', $result );
		$this->assertFileDoesNotExist( "{$this->user}/broken-include.tsl" );
	}

	/**
	 * The console seeds its canvas from `get` BEFORE dump_metadata arrives. A
	 * topology that only `include`s others owns few nodes of its own, so seeding
	 * the parsed file alone paints a sliver and the rest pops in on the next poll.
	 * `get` therefore ships the COMPOSED graph with the file — one round trip, not
	 * two (get, then expand), which is what made an include-based topology feel
	 * slow to load next to a flat one.
	 */
	public function test_get_ships_the_composed_graph_with_the_file(): void {
		\file_put_contents( "{$this->stock}/zebra-base.tsl", "make_node Tee zebra:tee\n" );
		\file_put_contents(
			"{$this->stock}/zebra-top.tsl",
			"include zebra-base\nmake_node Echo wombat-echo\n"
		);

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'get', 'zebra-top' );

		$this->assertIsArray( $result );
		$this->assertSame( [ 'zebra-base' ], $result['includes'] );
		$names = \array_column( $result['expanded']['nodes'], 'name' );
		$this->assertSame( [ 'zebra:tee' ], $names, 'the BORROWED nodes ride along' );
	}

	/** A topology with no includes ships an empty expansion, not a missing key. */
	public function test_get_ships_an_empty_expansion_when_there_are_no_includes(): void {
		\file_put_contents( "{$this->stock}/flat.tsl", "make_node Echo wombat-echo\n" );

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'get', 'flat' );

		$this->assertSame( [], $result['includes'] );
		$this->assertSame( [], $result['expanded']['nodes'] );
	}

	/** A flat topology keeps its own nodes editable while shipping resolved config routing for the console seed. */
	public function test_get_ships_resolved_config_edges_without_putting_own_nodes_in_the_include_expansion(): void {
		\Newspack_Nodes\Core::register_config_namespace(
			'wombat_get_seed',
			static fn ( string $key ): ?string => 'stats_sink' === $key ? 'violet-stats-sink-947' : null
		);
		\file_put_contents(
			"{$this->stock}/flat-config-target.tsl",
			"make_node Echo cerulean-flame-builder-619\n"
			. "make_node Echo violet-stats-sink-947\n"
			. "cmd cerulean-flame-builder-619:config set_stats_target <wombat_get_seed:stats_sink>\n"
		);

		$result = VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'get', 'flat-config-target' );

		$this->assertSame( [], $result['includes'] );
		$this->assertSame( [], $result['expanded']['nodes'], 'own nodes must not become borrowed include nodes' );
		$this->assertSame(
			[
				[
					'from'         => 'cerulean-flame-builder-619',
					'to'           => 'violet-stats-sink-947',
					'origin'       => [ 'flat-config-target' ],
					'roles'        => [ 'config' ],
					'config_slots' => [ 'set_stats_target' ],
				],
			],
			$result['resolved_config_edges']
		);
	}
}
