<?php
/**
 * Tests for the substrate's `newspack_nodes/vault/changed` reload signal.
 *
 * A Vault mutation re-credentials the spokes, so the workers holding a
 * vault-consuming node (`Remote_Link` / `Remote_Source`) must RE-READ their
 * config — not exit. Which topologies those are is DERIVED from each active
 * topology's parsed graph; a hardcoded topology name is deployment config and
 * drifts silently into a no-op.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Config;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;

#[CoversClass( Bootstrap::class )]
class BootstrapVaultReloadTest extends TestCase {

	private string $base_dir;
	private string $stock;

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir( 'vault-reload-' );
		$this->use_base_dir( $this->base_dir );

		$this->stock = $this->make_temp_dir( 'vault-reload-stock-' );
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );

		// Deliberately non-stock names: nothing may key off a known topology.
		$this->write_tsl(
			'spoke-pull-lab',
			"make_node Remote_Source oddball-puller vault-9317 firehose 0\n"
		);
		$this->write_tsl( 'quiet-lab', "make_node Echo hush-relay\n" );
		\update_option( 'newspack_nodes_topologies', [ 'spoke-pull-lab', 'quiet-lab' ] );
		Config::reset();

		$this->make_lock_dir( 'spoke-pull-lab' );
		$this->make_lock_dir( 'quiet-lab' );
	}

	protected function tearDown(): void {
		\delete_option( 'newspack_nodes_topologies' );
		Config::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->base_dir );
		parent::tearDown();
	}

	private function write_tsl( string $name, string $contents ): void {
		\file_put_contents( "{$this->stock}/{$name}.tsl", $contents );
	}

	private function make_lock_dir( string $name ): void {
		\mkdir( "{$this->base_dir}/locks/{$name}.p0.lock.d", 0777, true );
	}

	private function flag( string $name, string $flag ): string {
		return "{$this->base_dir}/locks/{$name}.p0.lock.d/{$flag}";
	}

	public function test_signals_reload_and_never_restart_on_the_vault_consumer(): void {
		Bootstrap::reload_vault_consumers();

		$this->assertFileExists( $this->flag( 'spoke-pull-lab', Lock_Node::RELOAD_FLAG ) );
		$this->assertFileDoesNotExist(
			$this->flag( 'spoke-pull-lab', Lock_Node::RESTART_FLAG ),
			'a vault change must never cost a process recycle'
		);
	}

	public function test_a_topology_with_no_vault_consumer_gets_no_flag_at_all(): void {
		Bootstrap::reload_vault_consumers();

		$this->assertFileDoesNotExist( $this->flag( 'quiet-lab', Lock_Node::RELOAD_FLAG ) );
		$this->assertFileDoesNotExist( $this->flag( 'quiet-lab', Lock_Node::RESTART_FLAG ) );
	}

	public function test_remote_link_also_counts_as_a_vault_consumer(): void {
		$this->write_tsl( 'link-lab', "make_node Remote_Link odd-linker vault-9317 firehose.p0\n" );
		\update_option( 'newspack_nodes_topologies', [ 'link-lab', 'quiet-lab' ] );
		Config::reset();
		$this->make_lock_dir( 'link-lab' );

		Bootstrap::reload_vault_consumers();

		$this->assertFileExists( $this->flag( 'link-lab', Lock_Node::RELOAD_FLAG ) );
		$this->assertFileDoesNotExist( $this->flag( 'quiet-lab', Lock_Node::RELOAD_FLAG ) );
	}

	public function test_every_partition_of_a_consuming_topology_is_signalled(): void {
		// 3 partitions — distinct from the global default of 1, so a version that
		// only ever flags .p0 fails here.
		$this->write_tsl(
			'wide-lab',
			"var num_partitions = 3\nmake_node Remote_Source wide-puller vault-9317 firehose 0\n"
		);
		\update_option( 'newspack_nodes_topologies', [ 'wide-lab' ] );
		Config::reset();
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$this->base_dir}/locks/wide-lab.p{$p}.lock.d", 0777, true );
		}

		Bootstrap::reload_vault_consumers();

		for ( $p = 0; $p < 3; $p++ ) {
			$this->assertFileExists(
				"{$this->base_dir}/locks/wide-lab.p{$p}.lock.d/" . Lock_Node::RELOAD_FLAG
			);
		}
	}

	public function test_unparseable_topology_is_skipped_and_the_rest_still_signal(): void {
		$this->write_tsl( 'broken-lab', "include no-such-topology-4471\n" );
		\update_option( 'newspack_nodes_topologies', [ 'spoke-pull-lab', 'broken-lab' ] );
		Config::reset();
		$this->make_lock_dir( 'broken-lab' );

		Bootstrap::reload_vault_consumers();

		$this->assertFileExists( $this->flag( 'spoke-pull-lab', Lock_Node::RELOAD_FLAG ) );
		$this->assertFileDoesNotExist( $this->flag( 'broken-lab', Lock_Node::RELOAD_FLAG ) );
	}

	public function test_a_throwing_provider_does_not_fatal_the_vault_save(): void {
		Bootstrap::$supervisor_factory = static function (): Spawn_Coordinator {
			throw new \RuntimeException( 'spawn coordinator unavailable 8823' );
		};

		Bootstrap::reload_vault_consumers();

		$this->assertFileDoesNotExist( $this->flag( 'spoke-pull-lab', Lock_Node::RELOAD_FLAG ) );
	}

	public function test_the_listener_is_wired_to_the_vault_changed_action(): void {
		$this->assertContains(
			[ Bootstrap::class, 'reload_vault_consumers' ],
			$GLOBALS['_wp_actions']['newspack_nodes/vault/changed'] ?? [],
			'ensure_runtime_wired must hook the vault reload'
		);

		\do_action( 'newspack_nodes/vault/changed', 'vault-9317', 'updated' );

		$this->assertFileExists( $this->flag( 'spoke-pull-lab', Lock_Node::RELOAD_FLAG ) );
	}
}
