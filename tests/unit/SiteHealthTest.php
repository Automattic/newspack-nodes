<?php
/**
 * SiteHealthTest: the substrate's WP Site Health integration + alert-emit wiring.
 *
 * Bootstrap registers ONE `direct` Site Health test that reports the Alerts
 * evaluator's worst severity, and wires the alert-emit + site_status_tests
 * hooks in ensure_runtime_wired().
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Alerts;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Bootstrap::class )]
class SiteHealthTest extends TestCase {

	private ?string $tmp = null;

	protected function setUp(): void {
		parent::setUp();
		\Newspack_Nodes\Topology_Registry::reset();
		$GLOBALS['_wp_options'] = [];
		$GLOBALS['_wp_actions'] = [];
	}

	protected function tearDown(): void {
		\Newspack_Nodes\Topology_Registry::reset();
		$GLOBALS['_wp_options'] = [];
		$GLOBALS['_wp_actions'] = [];
		if ( null !== $this->tmp ) {
			$this->rmdir_recursive( $this->tmp );
			$this->tmp = null;
		}
		parent::tearDown();
	}

	private function arrange( string $type ): string {
		$this->tmp = (string) \realpath( \sys_get_temp_dir() ) . '/site-health-test-' . \uniqid();
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

	public function test_register_site_health_tests_adds_a_direct_test(): void {
		$tests = Bootstrap::register_site_health_tests( [ 'direct' => [], 'async' => [] ] );

		$this->assertArrayHasKey( Bootstrap::SITE_HEALTH_TEST, $tests['direct'] );
		$this->assertIsCallable( $tests['direct'][ Bootstrap::SITE_HEALTH_TEST ]['test'] );
	}

	public function test_run_health_test_reports_good_when_fleet_is_clean(): void {
		$base = $this->arrange( 'live-workers' );
		$this->seed_heartbeat( $base, 'live-workers', 0 );

		$result = Bootstrap::run_workers_health_test();

		$this->assertSame( 'good', $result['status'] );
		$this->assertSame( Bootstrap::SITE_HEALTH_TEST, $result['test'] );
	}

	public function test_run_health_test_reports_critical_on_worker_down(): void {
		$base = $this->arrange( 'stale-workers' );
		$this->seed_heartbeat( $base, 'stale-workers', 120 ); // stale → dead → critical.

		$result = Bootstrap::run_workers_health_test();

		$this->assertSame( 'critical', $result['status'] );
		$this->assertStringContainsString( 'stale-workers.p0', $result['description'] );
	}

	public function test_run_health_test_reports_recommended_on_warning_only(): void {
		$base = $this->arrange( 'live-workers' );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		\mkdir( "{$base}/deadletter/jobs.p0", 0755, true );
		\file_put_contents( "{$base}/deadletter/jobs.p0/0.log", 'x' );

		$result = Bootstrap::run_workers_health_test();

		$this->assertSame( 'recommended', $result['status'] );
	}

	public function test_ensure_runtime_wired_registers_site_health_and_alert_hooks(): void {
		$wired_ref   = new \ReflectionProperty( Bootstrap::class, 'runtime_wired' );
		$saved_wired = $wired_ref->getValue();
		$saved_memd  = Core::$memd;

		try {
			$GLOBALS['_wp_actions'] = [];
			$wired_ref->setValue( null, false );
			Bootstrap::ensure_runtime_wired();

			$tests = \apply_filters( 'site_status_tests', [ 'direct' => [], 'async' => [] ] );
			$this->assertArrayHasKey( Bootstrap::SITE_HEALTH_TEST, $tests['direct'] );

			$this->assertNotEmpty(
				$GLOBALS['_wp_actions']['newspack_nodes/supervisor_periodic'] ?? [],
				'alert emit must be hooked to the supervisor periodic tick'
			);
		} finally {
			$wired_ref->setValue( null, $saved_wired );
			Core::$memd = $saved_memd;
		}
	}
}
