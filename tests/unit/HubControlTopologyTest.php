<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;

/** The shipped hub-control topology wires the settings-sync geometry pushes. */
class HubControlTopologyTest extends TestCase {

	/**
	 * Parse the shipped hub-control.tsl's `add_setting <hub> settings <spoke>`
	 * lines into a hub-option => spoke-option map (the settings-sync mapping).
	 *
	 * @return array<string,string>
	 */
	private function settings_sync_map(): array {
		$tsl = \file_get_contents( \dirname( __DIR__, 2 ) . '/topologies/hub-control.tsl' );
		$this->assertNotFalse( $tsl, 'hub-control.tsl must be readable' );

		$map = [];
		foreach ( \explode( "\n", $tsl ) as $line ) {
			if ( \preg_match( '/add_setting\s+(\S+)\s+settings\s+(\S+)/', $line, $m ) ) {
				$map[ $m[1] ] = $m[2];
			}
		}
		return $map;
	}

	public function test_geometry_pushes_map_renamed_hub_options_to_new_spoke_local_keys(): void {
		$map = $this->settings_sync_map();

		$this->assertSame( 'newspack_nodes_max_segments', $map['newspack_nodes_remote_max_segments'] ?? null );
		$this->assertSame( 'newspack_nodes_segment_size', $map['newspack_nodes_remote_segment_size'] ?? null );
		$this->assertSame( 'newspack_nodes_min_lifetime', $map['newspack_nodes_remote_min_lifetime'] ?? null );
	}

	public function test_no_pushes_reference_the_deleted_local_or_remote_keys(): void {
		$map = $this->settings_sync_map();

		$this->assertArrayNotHasKey( 'newspack_nodes_remote_num_segments', $map );
		$this->assertArrayNotHasKey( 'newspack_nodes_remote_max_lifespan', $map );
		$this->assertNotContains( 'newspack_nodes_num_segments', $map, 'a push still targets the deleted local num_segments key' );
		$this->assertNotContains( 'newspack_nodes_max_lifespan', $map, 'a push still targets the deleted local max_lifespan key' );
	}
}
