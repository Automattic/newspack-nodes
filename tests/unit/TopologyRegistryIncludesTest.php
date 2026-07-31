<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Topology_Registry::includes() — the transitive include set of one topology.
 *
 * Callers ask "does this deployment run X?" and a deployment routinely runs X
 * through a locally-named wrapper (`aggregator-eve` including `aggregator`).
 * A membership test against the ACTIVE topology names alone answers no there,
 * which is how per-server stats stopped being written on a wrapped hub.
 */
#[CoversClass( Topology_Registry::class )]
class TopologyRegistryIncludesTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'topology-includes-' );
		Topology_Registry::register_stock_dir( $this->tmp );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function write_tsl( string $name, string $contents ): void {
		\file_put_contents( "{$this->tmp}/{$name}.tsl", $contents );
	}

	public function test_includes_reports_a_directly_declared_include(): void {
		$this->write_tsl( 'okapi-leaf', "make_node Tee okapi-tee\n" );
		$this->write_tsl( 'okapi-wrapper', "include okapi-leaf\nmake_node Tee okapi-extra\n" );

		$this->assertSame( [ 'okapi-leaf' ], Topology_Registry::includes( 'okapi-wrapper' ) );
	}

	public function test_includes_reaches_through_a_nested_include(): void {
		$this->write_tsl( 'okapi-deep', "make_node Tee okapi-deep-tee\n" );
		$this->write_tsl( 'okapi-mid', "include okapi-deep\n" );
		$this->write_tsl( 'okapi-top', "include okapi-mid\n" );

		$out = Topology_Registry::includes( 'okapi-top' );
		\sort( $out );

		$this->assertSame( [ 'okapi-deep', 'okapi-mid' ], $out );
	}

	public function test_includes_excludes_the_topology_itself(): void {
		$this->write_tsl( 'okapi-lonely', "make_node Tee okapi-lonely-tee\n" );

		$this->assertSame( [], Topology_Registry::includes( 'okapi-lonely' ) );
	}

	public function test_includes_returns_empty_for_an_unknown_topology(): void {
		$this->assertSame( [], Topology_Registry::includes( 'okapi-never-registered' ) );
	}
}
