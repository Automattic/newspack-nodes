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

	/**
	 * The shared cache tier is a cross-process source of truth, so a page view
	 * that asks for the handle gets the same one a worker holds; a request
	 * writing to APCu beside workers on memcached would straddle tiers.
	 */
	public function test_a_page_view_asking_for_the_handle_gets_the_configured_one(): void {
		$result = $this->run_entrypoint( 'frontend' );

		$this->assertSame( '127.0.0.1:11943', $result['server'] );
	}

	/**
	 * Loading the plugin file is on every request's critical path, before
	 * anything knows whether it needs the cache: it must not load the config
	 * system or connect memcached until something asks.
	 */
	public function test_loading_the_plugin_file_wires_nothing_a_page_view_may_not_need(): void {
		$result = $this->run_entrypoint( 'frontend' );

		$this->assertFalse( $result['config_at_load'], 'the config system loaded with the plugin file' );
		$this->assertFalse( $result['handle_at_load'], 'memcached connected with the plugin file' );
	}

	/**
	 * A page view's spawn POST can precede every cache read, so its TLS posture
	 * cannot depend on something else having wired the diagnostics first.
	 */
	public function test_a_page_view_spawn_post_honours_spawn_verify_ssl(): void {
		$result = $this->run_entrypoint( 'frontend' );

		$this->assertFalse( $result['spawn_verify'] );
	}

	/**
	 * WordPress's weekly Site Health check runs from wp-cron, neither admin
	 * nor WP-CLI; the substrate's test must be registered there too.
	 */
	public function test_site_health_test_is_registered_on_a_non_admin_request(): void {
		$result = $this->run_entrypoint( 'frontend' );

		$this->assertTrue( $result['site_health'] );
	}

	/**
	 * A page view builds Partitions — `Job_Intake::feed()` from a render, the
	 * settings writer on an option change — whose schema defaults are strict
	 * `<config:*>` tokens, so the namespace must be live without any wiring.
	 */
	public function test_a_page_view_resolves_config_tokens_without_wiring(): void {
		$result = $this->run_entrypoint( 'frontend' );

		$this->assertMatchesRegularExpression( '/^\d+$/', $result['min_segments'] );
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
