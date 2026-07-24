<?php
/**
 * AdminAlertNoticeTest: the substrate Admin's fleet-alert admin notice.
 *
 * On the Nodes admin pages, for manage_options users, Admin renders ONE notice
 * summarizing the Alerts evaluator's count + worst severity — never a notice
 * per alert, never off the substrate's own pages.
 *
 * @package Newspack_Nodes
 */

namespace {
	require_once \dirname( __DIR__, 3 ) . '/includes/admin/class-admin.php';
}

namespace Newspack_Nodes\Tests\Unit\Admin {

use Newspack_Nodes\Admin\Admin;
use Newspack_Nodes\Config;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Admin::class )]
class AdminAlertNoticeTest extends TestCase {

	private ?string $tmp = null;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_actions']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		unset( $_GET['page'] );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_actions']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		unset( $_GET['page'] );
		if ( null !== $this->tmp ) {
			$this->rmdir_recursive( $this->tmp );
			$this->tmp = null;
		}
		parent::tearDown();
	}

	private function arrange( string $type ): string {
		$this->tmp = (string) \realpath( \sys_get_temp_dir() ) . '/admin-notice-test-' . \uniqid();
		\mkdir( $this->tmp, 0755, true );
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 1 ] );
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ) use ( $type ): array {
				$topologies[ $type ] = [ 'topology' => $type, 'num_partitions' => 1, 'stale_timeout' => 60 ];
				return $topologies;
			}
		);
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ $type ];
		Config::reset();
		return $this->tmp;
	}

	private function seed_heartbeat( string $base, string $type, int $age_seconds ): void {
		$lock_dir = "{$base}/locks/{$type}.p0.lock.d";
		\mkdir( $lock_dir, 0755, true );
		\touch( "{$lock_dir}/heartbeat", \time() - $age_seconds );
	}

	private function render(): string {
		\ob_start();
		( new Admin() )->render_alert_notice();
		return (string) \ob_get_clean();
	}

	public function test_renders_error_notice_with_worst_severity_on_nodes_page(): void {
		$base           = $this->arrange( 'stale-workers' );
		$this->seed_heartbeat( $base, 'stale-workers', 120 ); // critical.
		$_GET['page']   = Admin::HUB_MENU_SLUG;

		$html = $this->render();

		$this->assertStringContainsString( 'notice-error', $html );
		$this->assertStringContainsString( 'critical', $html );
	}

	public function test_renders_warning_notice_for_warning_only_fleet(): void {
		$base         = $this->arrange( 'live-workers' );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		\mkdir( "{$base}/deadletter/jobs.p0", 0755, true );
		\file_put_contents( "{$base}/deadletter/jobs.p0/0.log", 'x' );
		$_GET['page'] = Admin::MENU_SLUG;

		$html = $this->render();

		$this->assertStringContainsString( 'notice-warning', $html );
		$this->assertStringNotContainsString( 'notice-error', $html );
	}

	public function test_no_notice_when_fleet_is_clean(): void {
		$base         = $this->arrange( 'live-workers' );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		$_GET['page'] = Admin::HUB_MENU_SLUG;

		$this->assertSame( '', $this->render() );
	}

	public function test_no_notice_off_the_nodes_pages(): void {
		$base         = $this->arrange( 'stale-workers' );
		$this->seed_heartbeat( $base, 'stale-workers', 120 );
		$_GET['page'] = 'some-other-plugin';

		$this->assertSame( '', $this->render() );
	}

	public function test_no_notice_without_manage_options(): void {
		$base                                 = $this->arrange( 'stale-workers' );
		$this->seed_heartbeat( $base, 'stale-workers', 120 );
		$_GET['page']                         = Admin::HUB_MENU_SLUG;
		$GLOBALS['_wp_test_current_user_can'] = [];

		$this->assertSame( '', $this->render() );
	}
}

}
