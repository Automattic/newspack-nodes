<?php
/**
 * Every reader a stock topology declares must be durable.
 *
 * The offsetlog and dead-letter dirs are arguments, and omitting one fails SILENT:
 * no cursor means the reader replays from the head after every restart; no
 * quarantine means poison is logged and dropped. Ten Consumers shipped without a
 * dead-letter dir before this guard existed.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\Helpers\TopologyDurability;
use Newspack_Nodes\Tests\TestCase;

class TopologyDurabilityTest extends TestCase {

	public function test_stock_topologies_declare_a_cursor_and_a_quarantine(): void {
		$violations = TopologyDurability::audit( \dirname( __DIR__, 2 ) . '/topologies' );
		$this->assertSame( [], $violations, \implode( "\n", $violations ) );
	}

	public function test_bundled_example_topologies_declare_them_too(): void {
		$violations = TopologyDurability::audit(
			\dirname( __DIR__, 2 ) . '/examples/example-ai-newsletter/topologies'
		);
		$this->assertSame( [], $violations, \implode( "\n", $violations ) );
	}

	/**
	 * The guard's own guard: a reader missing a durability arg must be REPORTED.
	 * Without this, the audit passing proves nothing — an audit that never fires
	 * is indistinguishable from a clean tree.
	 */
	public function test_a_reader_missing_its_deadletter_dir_is_reported(): void {
		$dir = $this->make_temp_dir();
		\file_put_contents(
			"{$dir}/bad.tsl",
			"# a Consumer with a cursor but no quarantine\n"
			. "make_node Consumer feed:consumer /logs/feed.p0 /offsets/feed.p0\n"
		);

		$violations = TopologyDurability::audit( $dir );

		$this->assertCount( 1, $violations );
		$this->assertStringContainsString( 'feed:consumer (Consumer)', $violations[0] );
		$this->assertStringContainsString( 'deadletter_dir', $violations[0] );
		$this->rmdir_recursive( $dir );
	}

	public function test_a_reader_missing_both_dirs_is_reported_twice(): void {
		$dir = $this->make_temp_dir();
		\file_put_contents( "{$dir}/bare.tsl", "make_node Consumer feed:consumer /logs/feed.p0\n" );

		$violations = TopologyDurability::audit( $dir );

		$this->assertCount( 2, $violations );
		$this->rmdir_recursive( $dir );
	}

	/** A node with no durability args (a Partition, a Tee) is not a reader — skip it. */
	public function test_a_non_reader_is_not_flagged(): void {
		$dir = $this->make_temp_dir();
		\file_put_contents(
			"{$dir}/writers.tsl",
			"make_node Partition jobs:partition /logs/jobs.p0 1048576 2 4 0 0\n"
			. "make_node Tee jobs:tee\n"
		);

		$this->assertSame( [], TopologyDurability::audit( $dir ) );
		$this->rmdir_recursive( $dir );
	}
}
