<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;

/** The shipped hub-control topology wires the settings-sync geometry pushes. */
class HubControlTopologyTest extends TestCase {

	/**
	 * Parse the shipped hub-control.tsl's `add_setting <hub> settings <spoke>`
	 * lines into a hub-option => list-of-spoke-options map. One watched option
	 * can push to several spoke keys (add_setting accumulates a spec list), so
	 * the map is a list per key, not a single value.
	 *
	 * @return array<string,list<string>>
	 */
	private function settings_sync_map(): array {
		$tsl = \file_get_contents( \dirname( __DIR__, 2 ) . '/topologies/hub-control.tsl' );
		$this->assertNotFalse( $tsl, 'hub-control.tsl must be readable' );

		$map = [];
		foreach ( \explode( "\n", $tsl ) as $line ) {
			if ( \preg_match( '/add_setting\s+(\S+)\s+settings\s+(\S+)/', $line, $m ) ) {
				$map[ $m[1] ][] = $m[2];
			}
		}
		return $map;
	}

	public function test_geometry_pushes_apply_each_remote_option_to_its_spoke_local_key(): void {
		$map = $this->settings_sync_map();

		$this->assertContains( 'newspack_nodes_num_segments', $map['newspack_nodes_remote_max_segments'] ?? [] );
		$this->assertContains( 'newspack_nodes_segment_size', $map['newspack_nodes_remote_segment_size'] ?? [] );
		$this->assertContains( 'newspack_nodes_min_lifetime', $map['newspack_nodes_remote_min_lifetime'] ?? [] );
		$this->assertContains( 'newspack_nodes_lifetime', $map['newspack_nodes_remote_max_lifetime'] ?? [] );
	}

	public function test_geometry_pushes_also_seed_each_spoke_remote_copy_for_onward_propagation(): void {
		$map = $this->settings_sync_map();

		// Each remote_* key also maps to its own remote_* on the spoke, so a
		// spoke re-propagates the geometry to ITS spokes.
		$this->assertContains( 'newspack_nodes_remote_max_segments', $map['newspack_nodes_remote_max_segments'] ?? [] );
		$this->assertContains( 'newspack_nodes_remote_segment_size', $map['newspack_nodes_remote_segment_size'] ?? [] );
		$this->assertContains( 'newspack_nodes_remote_min_lifetime', $map['newspack_nodes_remote_min_lifetime'] ?? [] );
	}

	public function test_no_pushes_reference_the_deleted_local_or_remote_keys(): void {
		$map = $this->settings_sync_map();

		$this->assertArrayNotHasKey( 'newspack_nodes_remote_num_segments', $map );
		$this->assertArrayNotHasKey( 'newspack_nodes_remote_max_lifespan', $map );

		$targets = $map ? \array_merge( ...\array_values( $map ) ) : [];
		$this->assertNotContains( 'newspack_nodes_max_lifetime', $targets, 'a push still targets the renamed-away local max_lifetime key' );
		$this->assertNotContains( 'newspack_nodes_max_lifespan', $targets, 'a push still targets the deleted local max_lifespan key' );
	}
}
