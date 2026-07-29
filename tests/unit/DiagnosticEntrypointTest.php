<?php
/**
 * Production-entrypoint coverage for dependency-free diagnostic surfaces.
 *
 * @package Newspack_Nodes\Tests
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
class DiagnosticEntrypointTest extends TestCase {

	/**
	 * Execute the real plugin file in a fresh PHP process.
	 *
	 * @return array<string,mixed>
	 */
	private function run_entrypoint( string $surface ): array {
		$command = [
			\PHP_BINARY,
			\dirname( __DIR__ ) . '/fixtures/diagnostic-entrypoint.php',
			$surface,
		];
		$pipes   = [];
		$process = \proc_open(
			$command,
			[
				0 => [ 'pipe', 'r' ],
				1 => [ 'pipe', 'w' ],
				2 => [ 'pipe', 'w' ],
			],
			$pipes
		);
		$this->assertIsResource( $process );
		\fclose( $pipes[0] );
		$stdout = \stream_get_contents( $pipes[1] );
		$stderr = \stream_get_contents( $pipes[2] );
		\fclose( $pipes[1] );
		\fclose( $pipes[2] );
		$exit = \proc_close( $process );

		$this->assertSame( 0, $exit, $stderr );
		$this->assertIsString( $stdout );
		/** @var array<string,mixed> $decoded */
		$decoded = \json_decode( $stdout, true, 512, \JSON_THROW_ON_ERROR );
		$this->assertArrayNotHasKey( 'error_class', $decoded, $decoded['error_message'] ?? $stderr );
		return $decoded;
	}

	public function test_site_health_registers_and_runs_after_full_admin_init_with_invalid_base(): void {
		$result = $this->run_entrypoint( 'site-health' );

		$this->assertTrue( $result['registered'] );
		$this->assertSame( 'critical', $result['status'] );
		$this->assertStringContainsString( $result['blocked_base'], $result['description'] );
		$this->assertSame( 'memcached', $result['cache_backend'] );
	}

	public function test_doctor_command_registers_and_reports_invalid_base(): void {
		$result = $this->run_entrypoint( 'doctor' );
		$output = \implode( "\n", [ ...$result['logs'], ...$result['errors'] ] );

		$this->assertTrue( $result['registered'] );
		$this->assertStringContainsString( 'FAIL filesystem', $output );
		$this->assertStringContainsString( $result['blocked_base'], $output );
		$this->assertFalse( $result['sslverify'] );
	}

	public function test_health_cache_route_completes_rest_init_and_responds_with_invalid_base(): void {
		$result = $this->run_entrypoint( 'health-rest' );

		$this->assertTrue( $result['registered'] );
		$this->assertTrue( $result['permission'] );
		$this->assertSame( 200, $result['status'] );
	}

	public function test_first_topology_console_callback_localizes_runtime_topologies(): void {
		$result = $this->run_entrypoint( 'topology-console' );

		$this->assertTrue( $result['registered'] );
		$this->assertSame(
			[
				'admin-entrypoint-8843' => 7,
				'job-intake'            => 6,
				'job-worker'            => 6,
				'settings-sync'         => 1,
				'topic-probe'           => 6,
			],
			$result['topology_workers']
		);
		$this->assertSame( [ 'admin-entrypoint-8843' ], $result['active_topologies'] );
	}
}
