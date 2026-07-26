<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\Settings_CI_Node;
use Newspack_Nodes\Tests\TestCase;

/** The shipped settings-sync topology wires the remote_* geometry pushes. */
class SettingsSyncTopologyTest extends TestCase {

	/**
	 * Parse the shipped settings-sync.tsl's `add_setting <hub> settings <spoke>`
	 * lines into a hub-option => list-of-spoke-options map. One watched option
	 * can push to several spoke keys (add_setting accumulates a spec list), so
	 * the map is a list per key, not a single value.
	 *
	 * @return array<string,list<string>>
	 */
	private function settings_sync_map(): array {
		$tsl = \file_get_contents( \dirname( __DIR__, 2 ) . '/topologies/settings-sync.tsl' );
		$this->assertNotFalse( $tsl, 'settings-sync.tsl must be readable' );

		$map = [];
		foreach ( \explode( "\n", $tsl ) as $line ) {
			if ( \preg_match( '/add_setting\s+(\S+)\s+settings\s+(\S+)/', $line, $m ) ) {
				$map[ $m[1] ][] = $m[2];
			}
		}
		return $map;
	}

	/**
	 * The option names actually SENT — `send_set` ships `$spec['remote']`, the
	 * map's values. A guard over the keys checks the hub's own axis names and
	 * misses every push whose spoke-side name differs, which is the whole point.
	 *
	 * @return list<string>
	 */
	private function pushed_options(): array {
		$map = $this->settings_sync_map();
		return $map ? \array_values( \array_unique( \array_merge( ...\array_values( $map ) ) ) ) : [];
	}

	public function test_geometry_pushes_apply_each_remote_option_to_its_spoke_local_key(): void {
		$map = $this->settings_sync_map();

		$this->assertContains( 'newspack_nodes_num_segments', $map['newspack_nodes_remote_num_segments'] ?? [] );
		$this->assertContains( 'newspack_nodes_segment_size', $map['newspack_nodes_remote_segment_size'] ?? [] );
		$this->assertContains( 'newspack_nodes_min_lifetime', $map['newspack_nodes_remote_min_lifetime'] ?? [] );
		$this->assertContains( 'newspack_nodes_lifetime', $map['newspack_nodes_remote_lifetime'] ?? [] );
		// The reborn remote_max_segments now pushes the spoke's HARD cap.
		$this->assertContains( 'newspack_nodes_max_segments', $map['newspack_nodes_remote_max_segments'] ?? [] );
	}

	public function test_geometry_pushes_also_seed_each_spoke_remote_copy_for_onward_propagation(): void {
		$map = $this->settings_sync_map();

		// Each remote_* key also maps to its own remote_* on the spoke, so a
		// spoke re-propagates the geometry to ITS spokes.
		$this->assertContains( 'newspack_nodes_remote_num_segments', $map['newspack_nodes_remote_num_segments'] ?? [] );
		$this->assertContains( 'newspack_nodes_remote_segment_size', $map['newspack_nodes_remote_segment_size'] ?? [] );
		$this->assertContains( 'newspack_nodes_remote_min_lifetime', $map['newspack_nodes_remote_min_lifetime'] ?? [] );
		$this->assertContains( 'newspack_nodes_remote_lifetime', $map['newspack_nodes_remote_lifetime'] ?? [] );
		$this->assertContains( 'newspack_nodes_remote_max_segments', $map['newspack_nodes_remote_max_segments'] ?? [] );
	}

	public function test_no_pushes_reference_the_deleted_local_or_remote_keys(): void {
		$map = $this->settings_sync_map();

		$this->assertArrayNotHasKey( 'newspack_nodes_remote_max_lifetime', $map );
		$this->assertArrayNotHasKey( 'newspack_nodes_remote_max_lifespan', $map );

		$targets = $map ? \array_merge( ...\array_values( $map ) ) : [];
		$this->assertNotContains( 'newspack_nodes_max_lifetime', $targets, 'a push still targets the renamed-away local max_lifetime key' );
		$this->assertNotContains( 'newspack_nodes_max_lifespan', $targets, 'a push still targets the deleted local max_lifespan key' );
	}

	/**
	 * Every option this topology pushes must be one the receiving spoke's `set`
	 * verb accepts. The two lists drifted silently: cmd_set's allowlist held
	 * only the LOCAL axis names, so every remote_* push a hub ever made was
	 * refused as an unknown setting, and nothing said so until the reply leg
	 * started surfacing errors.
	 */
	public function test_every_pushed_option_is_accepted_by_the_spoke_set_verb(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$pushed = $this->pushed_options();
		$this->assertNotEmpty( $pushed, 'the topology must push something' );
		$this->assertContains(
			'newspack_nodes_num_segments',
			$pushed,
			'the guard must cover spoke-side names the hub does not push under'
		);

		foreach ( $pushed as $option ) {
			// A value distinct from every default and floor, so a silently
			// ignored write cannot look like a successful one.
			Settings_CI_Node::cmd_set( [ $option, '4177' ] );
			$this->assertSame(
				4177,
				$GLOBALS['_wp_options'][ $option ] ?? null,
				"the spoke's set verb refused {$option}"
			);
		}
	}

	/**
	 * And the spoke must be able to READ back what it was told. Config is
	 * fail-loud on undeclared keys, so a pushed option missing from the schema
	 * stores a value nothing can consume.
	 */
	public function test_every_pushed_option_is_declared_in_the_schema(): void {
		$declared = \Newspack_Nodes\Settings_Schema::get()->overlay_keys();

		foreach ( $this->pushed_options() as $option ) {
			$short = \substr( $option, \strlen( 'newspack_nodes_' ) );
			$this->assertContains( $short, $declared, "the schema does not declare {$short}" );
		}
	}
}
