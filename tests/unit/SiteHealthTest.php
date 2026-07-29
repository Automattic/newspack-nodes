<?php
/**
 * SiteHealthTest: the substrate's WP Site Health integration + alert-emit wiring.
 *
 * Bootstrap registers ONE `direct` Site Health test that evaluates the
 * canonical seven-result report once. It stays direct because the evaluator
 * performs local cache/filesystem probes and fleet snapshot reads, not HTTP.
 * ensure_runtime_wired() also keeps the alert-emit hook.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Alerts;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Core;
use Newspack_Nodes\Health_Checks;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Bootstrap::class )]
class SiteHealthTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		Bootstrap::$health_report_evaluator = null;
		$GLOBALS['_wp_actions']             = [];
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		Bootstrap::$health_report_evaluator = null;
		$GLOBALS['_wp_actions']             = [];
		parent::tearDown();
	}

	public function test_bootstrap_exposes_health_report_evaluator_seam(): void {
		$this->assertTrue( \property_exists( Bootstrap::class, 'health_report_evaluator' ) );
	}

	/** @return list<array{id:string,label:string,status:string,messages:list<string>}> */
	private function good_report(): array {
		return [
			[
				'id'       => 'cache-backend',
				'label'    => 'Cache backend',
				'status'   => Health_Checks::STATUS_GOOD,
				'messages' => [ 'Cache backend health-7319 succeeded.' ],
			],
			[
				'id'       => 'filesystem',
				'label'    => 'Filesystem',
				'status'   => Health_Checks::STATUS_GOOD,
				'messages' => [ 'Filesystem health-7319 succeeded.' ],
			],
			[
				'id'       => 'ownership',
				'label'    => 'Ownership',
				'status'   => Health_Checks::STATUS_GOOD,
				'messages' => [ 'Ownership health-7319 succeeded.' ],
			],
			[
				'id'       => 'worker-liveness',
				'label'    => 'Worker liveness',
				'status'   => Health_Checks::STATUS_GOOD,
				'messages' => [ 'Worker liveness health-7319 succeeded.' ],
			],
			[
				'id'       => 'supervisor-liveness',
				'label'    => 'Supervisor liveness',
				'status'   => Health_Checks::STATUS_GOOD,
				'messages' => [ 'Supervisor liveness health-7319 succeeded.' ],
			],
			[
				'id'       => 'consumer-lag',
				'label'    => 'Consumer lag',
				'status'   => Health_Checks::STATUS_GOOD,
				'messages' => [ 'Consumer lag health-7319 succeeded.' ],
			],
			[
				'id'       => 'dead-letters',
				'label'    => 'Dead letters',
				'status'   => Health_Checks::STATUS_GOOD,
				'messages' => [ 'Dead letters health-7319 succeeded.' ],
			],
		];
	}

	public function test_register_site_health_tests_keeps_one_stable_direct_test(): void {
		$tests = Bootstrap::register_site_health_tests( [ 'direct' => [], 'async' => [] ] );

		$this->assertSame( 'newspack_nodes_fleet', Bootstrap::SITE_HEALTH_TEST );
		$this->assertSame( [ 'newspack_nodes_fleet' ], \array_keys( $tests['direct'] ) );
		$this->assertSame( 'Newspack Nodes health', $tests['direct']['newspack_nodes_fleet']['label'] );
		$this->assertSame(
			[ Bootstrap::class, 'run_workers_health_test' ],
			$tests['direct']['newspack_nodes_fleet']['test']
		);
		$this->assertIsCallable( $tests['direct']['newspack_nodes_fleet']['test'] );
		$this->assertSame( [], $tests['async'] );
	}

	public function test_run_health_test_evaluates_once_and_renders_all_seven_good_rows(): void {
		$report = $this->good_report();
		$calls  = 0;
		Bootstrap::$health_report_evaluator = static function () use ( $report, &$calls ): array {
			++$calls;
			return $report;
		};

		$result = Bootstrap::run_workers_health_test();

		$this->assertSame( 1, $calls );
		$this->assertSame( [ 'label', 'status', 'badge', 'description', 'test' ], \array_keys( $result ) );
		$this->assertSame( 'Newspack Nodes is healthy', $result['label'] );
		$this->assertSame( Health_Checks::STATUS_GOOD, $result['status'] );
		$this->assertSame( [ 'label' => 'Newspack Nodes', 'color' => 'blue' ], $result['badge'] );
		$this->assertSame( 'newspack_nodes_fleet', $result['test'] );
		$this->assertSame( 7, \substr_count( $result['description'], '<li>' ) );
		$this->assertSame( 7, \substr_count( $result['description'], '<strong>OK ' ) );
		foreach ( $report as $check ) {
			$this->assertStringContainsString( $check['label'], $result['description'] );
			$this->assertStringContainsString( $check['messages'][0], $result['description'] );
		}
	}

	public function test_run_health_test_renders_recommended_as_warn(): void {
		$report    = $this->good_report();
		$report[5] = [
			'id'       => 'consumer-lag',
			'label'    => 'Consumer lag',
			'status'   => Health_Checks::STATUS_RECOMMENDED,
			'messages' => [ 'Consumer health-reader-7319 is 8843 bytes behind.' ],
		];
		Bootstrap::$health_report_evaluator = static fn (): array => $report;

		$result = Bootstrap::run_workers_health_test();

		$this->assertSame( 'Newspack Nodes has health alerts', $result['label'] );
		$this->assertSame( Health_Checks::STATUS_RECOMMENDED, $result['status'] );
		$this->assertSame( [ 'label' => 'Newspack Nodes', 'color' => 'orange' ], $result['badge'] );
		$this->assertStringContainsString( '<strong>WARN Consumer lag</strong>', $result['description'] );
		$this->assertStringContainsString( 'Consumer health-reader-7319 is 8843 bytes behind.', $result['description'] );
	}

	public function test_run_health_test_renders_critical_as_fail_and_critical_wins(): void {
		$report    = $this->good_report();
		$report[5] = [
			'id'       => 'consumer-lag',
			'label'    => 'Consumer lag',
			'status'   => Health_Checks::STATUS_RECOMMENDED,
			'messages' => [ 'Consumer health-reader-7319 is 8843 bytes behind.' ],
		];
		$report[3] = [
			'id'       => 'worker-liveness',
			'label'    => 'Worker liveness',
			'status'   => Health_Checks::STATUS_CRITICAL,
			'messages' => [ 'Worker health-worker-7319 stopped heartbeating.' ],
		];
		Bootstrap::$health_report_evaluator = static fn (): array => $report;

		$result = Bootstrap::run_workers_health_test();

		$this->assertSame( Health_Checks::STATUS_CRITICAL, $result['status'] );
		$this->assertSame( [ 'label' => 'Newspack Nodes', 'color' => 'red' ], $result['badge'] );
		$this->assertStringContainsString( '<strong>WARN Consumer lag</strong>', $result['description'] );
		$this->assertStringContainsString( '<strong>FAIL Worker liveness</strong>', $result['description'] );
	}

	public function test_run_health_test_preserves_multiple_messages(): void {
		$report    = $this->good_report();
		$report[3] = [
			'id'       => 'worker-liveness',
			'label'    => 'Worker liveness',
			'status'   => Health_Checks::STATUS_CRITICAL,
			'messages' => [
				'Worker health-worker-a-7319 stopped heartbeating.',
				'Worker health-worker-b-8843 never started.',
			],
		];
		Bootstrap::$health_report_evaluator = static fn (): array => $report;

		$result = Bootstrap::run_workers_health_test();

		$this->assertStringContainsString(
			'<div>Worker health-worker-a-7319 stopped heartbeating.</div>',
			$result['description']
		);
		$this->assertStringContainsString(
			'<div>Worker health-worker-b-8843 never started.</div>',
			$result['description']
		);
	}

	public function test_run_health_test_escapes_result_labels_and_every_message(): void {
		$report    = $this->good_report();
		$report[6] = [
			'id'       => 'dead-letters',
			'label'    => '<label-7319>',
			'status'   => Health_Checks::STATUS_RECOMMENDED,
			'messages' => [
				'<script>health-8843</script>',
				'<img src=x onerror=health-7319>',
			],
		];
		Bootstrap::$health_report_evaluator = static fn (): array => $report;

		$result = Bootstrap::run_workers_health_test();

		$this->assertStringNotContainsString( '<label-7319>', $result['description'] );
		$this->assertStringNotContainsString( '<script>health-8843</script>', $result['description'] );
		$this->assertStringNotContainsString( '<img src=x onerror=health-7319>', $result['description'] );
		$this->assertStringContainsString( 'WARN &lt;label-7319&gt;', $result['description'] );
		$this->assertStringContainsString( '&lt;script&gt;health-8843&lt;/script&gt;', $result['description'] );
		$this->assertStringContainsString( '&lt;img src=x onerror=health-7319&gt;', $result['description'] );
	}

	public function test_ensure_runtime_wired_registers_site_health_and_alert_hooks(): void {
		$runtime_ref     = new \ReflectionProperty( Bootstrap::class, 'runtime_wired' );
		$diagnostics_ref = new \ReflectionProperty( Bootstrap::class, 'diagnostics_wired' );
		$saved_runtime   = $runtime_ref->getValue();
		$saved_diagnostics = $diagnostics_ref->getValue();
		$saved_memd      = Core::$memd;

		try {
			$GLOBALS['_wp_actions'] = [];
			$runtime_ref->setValue( null, false );
			$diagnostics_ref->setValue( null, false );
			Bootstrap::ensure_runtime_wired();

			$tests = \apply_filters( 'site_status_tests', [ 'direct' => [], 'async' => [] ] );
			$this->assertArrayHasKey( Bootstrap::SITE_HEALTH_TEST, $tests['direct'] );

			$this->assertContains(
				[ Alerts::class, 'emit' ],
				$GLOBALS['_wp_actions']['newspack_nodes/supervisor_periodic'] ?? [],
				'alert emit must be hooked to the supervisor periodic tick'
			);
		} finally {
			$runtime_ref->setValue( null, $saved_runtime );
			$diagnostics_ref->setValue( null, $saved_diagnostics );
			Core::$memd = $saved_memd;
		}
	}
}
