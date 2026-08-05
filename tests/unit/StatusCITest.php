<?php
/**
 * StatusCITest: unit tests for Status_CI, the substrate service-CI that
 * replaces the legacy StatusController.
 *
 * Asserts value-equivalence with the legacy `get_status()` payload — same
 * status / runtime_version / num_partitions / topologies / cache_available /
 * timestamp fields and the same defaults. Substrate config is seeded via
 * `TestCase::use_base_dir()`, mirroring AggregatorCITest.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Rest\Status_CI_Node;
use Newspack_Nodes\Rest\Classes_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Config as RuntimeConfig;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Topology_Registry;

#[CoversClass( Status_CI_Node::class )]
class StatusCITest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		// Service CI verbs are gate-by-default (manage_options) in the substrate;
		// these happy-path verbs run as an authorized admin (deny-path is its own test).
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		// /tmp directly to dodge symlink-resolved sys_get_temp_dir on macOS,
		// matching AggregatorCITest.
		$this->tmp = (string) \realpath( \sys_get_temp_dir() ) . '/status-ci-test-' . \uniqid();
		\mkdir( $this->tmp, 0755, true );
		$this->use_base_dir( $this->tmp );
		// The reported topology set is the substrate's ACTIVE set
		// (`Bootstrap::get_topologies()`), whose names are resolved against
		// the stock topology dir. Register it so the active names synthesize.
		Topology_Registry::register_stock_dir(
			\dirname( __DIR__, 2 ) . '/topologies'
		);
	}

	/**
	 * Declare the substrate's active topology set the operator way: the
	 * `newspack_nodes_topologies` option overlays the substrate config-file
	 * default. Reset the substrate Config so the overlay is picked up.
	 */
	private function activate_topologies( array $names ): void {
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = $names;
		RuntimeConfig::reset();
	}

	protected function tearDown(): void {
		VerbHarness::reset();
		$GLOBALS['_wp_test_current_user_can'] = [];
		$this->rmdir_recursive( $this->tmp );
		// activate_topologies() caches a substrate config snapshot; the base
		// setUp wipes the wp-option but not the RuntimeConfig cache, so reset it
		// here lest topologies=[] (or the activated set) bleed into a later test
		// class that reads substrate Config without first calling use_base_dir().
		RuntimeConfig::reset();
		parent::tearDown();
	}

	public function test_get_verb_returns_canonical_status_payload(): void {
		$this->use_base_dir( $this->tmp, [
			'num_partitions' => 4,
		] );
		$this->activate_topologies( [ 'settings-sync', 'job-worker' ] );
		Core::$memd = new InMemoryMemcached();
		$interpreter         = new Status_CI_Node();

		$before = \time();
		$result = VerbHarness::fire( $interpreter, 'status', 'get' );
		$after  = \time();

		$this->assertIsArray( $result );
		$this->assertSame( 'ok', $result['status'] );
		$this->assertSame( \NEWSPACK_NODES_VERSION, $result['runtime_version'] );
		$this->assertSame( 4, $result['num_partitions'] );
		$this->assertSame( [ 'settings-sync', 'job-worker' ], $result['topologies'] );
		$this->assertTrue( $result['cache_available'] );
		$this->assertIsInt( $result['timestamp'] );
		$this->assertGreaterThanOrEqual( $before, $result['timestamp'] );
		$this->assertLessThanOrEqual( $after, $result['timestamp'] );
	}

	public function test_topologies_reports_substrate_active_set_dropping_unresolvable_names(): void {
		// The reported list is the substrate ACTIVE set
		// (`Bootstrap::get_topologies()` keys), which drops names that don't
		// resolve to a real topology — NOT the raw config `topologies` array,
		// which would echo the bogus name verbatim.
		$this->activate_topologies( [ 'job-worker', 'no-such-topology' ] );
		$interpreter = new Status_CI_Node();

		$result = VerbHarness::fire( $interpreter, 'status', 'get' );

		$this->assertSame( [ 'job-worker' ], $result['topologies'] );
	}

	public function test_cache_unavailable_reports_false_when_memd_null(): void {
		Core::$memd                 = null;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$interpreter                = new Status_CI_Node();

		$result = VerbHarness::fire( $interpreter, 'status', 'get' );

		$this->assertFalse( $result['cache_available'] );
		$this->assertSame( 'ok', $result['status'] );
	}

	public function test_cache_available_reports_true_with_apcu_only(): void {
		Core::$memd                 = null;
		Cache_Backend::$apcu_usable = static fn (): bool => true;
		$interpreter                = new Status_CI_Node();

		$result = VerbHarness::fire( $interpreter, 'status', 'get' );

		$this->assertTrue( $result['cache_available'] );
		$this->assertSame( 'ok', $result['status'] );
	}

	public function test_num_partitions_defaults_to_one_when_missing(): void {
		// use_base_dir() with no extras seeds only base_directory, leaving
		// num_partitions to default to 1. Declare an explicitly EMPTY active set
		// (empty overlay) so the reported list is empty regardless of the
		// deployment's substrate config-file default for `topologies`.
		$this->activate_topologies( [] );
		$interpreter = new Status_CI_Node();

		$result = VerbHarness::fire( $interpreter, 'status', 'get' );

		$this->assertSame( 1, $result['num_partitions'] );
		$this->assertSame( [], $result['topologies'] );
	}

	// ── schema-driven dispatch ─────────────────────────────────────────────

	public function test_extends_service_ci_node(): void {
		$this->assertTrue(
			\is_subclass_of( Status_CI_Node::class, \Newspack_Nodes\Service_CI_Node::class ),
			'Status_CI_Node must extend Service_CI_Node so its node_schema is auto-wired by the catalog scan.'
		);
	}

	public function test_node_schema_declares_get_verb_with_category(): void {
		$schema = Status_CI_Node::node_schema();

		$this->assertIsArray( $schema );
		$this->assertSame( 'Service', $schema['category'] );
		$this->assertNotEmpty( $schema['description'] );
		$this->assertArrayHasKey( 'commands', $schema );
		$names = \array_column( $schema['commands'], 'name' );
		$this->assertSame( [ 'get' ], $names );
	}

	/**
	 * Catalog-visibility guard (carried over from the ELN ServiceCiHandlerGuardTest
	 * when this CI moved here): a future edit dropping node_schema's `category` to
	 * ''/'Hidden' would silently hide Status_CI from the Inspector/palette while
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
			'Status_CI',
			$by_shell,
			"Status_CI is absent from the class catalog — its node_schema category was dropped to ''/'Hidden', or class discovery is broken"
		);
		$this->assertSame( 'Service', $by_shell['Status_CI'] );
	}
}
