<?php
/**
 * Tests for `wp nodes doctor` — the four-leg environment preflight (memcache,
 * WP-Cron, shared filesystem, user ownership) with per-miss degradation text.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_CLI_Command;
use PHPUnit\Framework\Attributes\CoversClass;

require_once \dirname( __DIR__, 2 ) . '/includes/cli/class-worker-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( Worker_CLI_Command::class )]
class CliDoctorCommandTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'newspack-nodes-doctor-test-' );
		$this->use_base_dir( $this->tmp );

		$GLOBALS['_test_wp_cli_logs']    = [];
		$GLOBALS['_test_wp_cli_warns']   = [];
		$GLOBALS['_test_wp_cli_errors']  = [];
		$GLOBALS['_test_wp_cli_success'] = [];

		// Healthy baseline: every leg passes; each test breaks exactly one.
		Core::$memd                         = new InMemoryMemcached();
		$GLOBALS['_wp_test_next_scheduled'] = \time() + 42;
		CLI::$uid_provider                  = fn (): int => (int) \fileowner( $this->tmp );
	}

	protected function tearDown(): void {
		Core::$memd        = null;
		CLI::$uid_provider = null;
		unset( $GLOBALS['_wp_test_next_scheduled'] );
		\chmod( $this->tmp, 0755 );
		parent::tearDown();
	}

	private function run_doctor_expecting_error(): void {
		try {
			( new Worker_CLI_Command() )->doctor( [], [] );
			$this->fail( 'Expected WP_CLI::error for a failing check.' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'checks failed', $e->getMessage() );
		}
	}

	private function log_haystack(): string {
		return \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
	}

	public function test_all_checks_pass(): void {
		( new Worker_CLI_Command() )->doctor( [], [] );

		$haystack = $this->log_haystack();
		$this->assertStringContainsString( 'memcache', $haystack );
		$this->assertStringContainsString( 'wp-cron', $haystack );
		$this->assertStringContainsString( 'filesystem', $haystack );
		$this->assertStringContainsString( 'ownership', $haystack );
		$this->assertStringNotContainsString( 'FAIL', $haystack );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
		$this->assertStringContainsString( '4', $GLOBALS['_test_wp_cli_success'][0] );
	}

	public function test_missing_memcache_handle_fails_with_degradation(): void {
		Core::$memd = null;

		$this->run_doctor_expecting_error();

		$haystack = $this->log_haystack();
		$this->assertStringContainsString( 'FAIL memcache', $haystack );
		$this->assertStringContainsString( 'dark', $haystack );
		$this->assertStringContainsString( 'HMAC', $haystack );
		$this->assertStringContainsString( 'SSE', $haystack );
	}

	public function test_broken_memcache_roundtrip_fails(): void {
		Core::$memd = new class() extends InMemoryMemcached {
			public function get( string $key, ?callable $cache_cb = null, int $get_flags = 0 ): mixed {
				return false;
			}
		};

		$this->run_doctor_expecting_error();

		$this->assertStringContainsString( 'FAIL memcache', $this->log_haystack() );
	}

	public function test_unscheduled_supervisor_cron_fails_with_degradation(): void {
		$GLOBALS['_wp_test_next_scheduled'] = false;

		$this->run_doctor_expecting_error();

		$haystack = $this->log_haystack();
		$this->assertStringContainsString( 'FAIL wp-cron', $haystack );
		$this->assertStringContainsString( 'newspack_nodes/supervisor', $haystack );
		$this->assertStringContainsString( 'safety net', $haystack );
		$this->assertStringContainsString( 'manual restart', $haystack );
	}

	public function test_unwritable_base_directory_fails_with_degradation(): void {
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'permission checks are moot as root' );
		}
		\chmod( $this->tmp, 0555 );

		$this->run_doctor_expecting_error();

		$haystack = $this->log_haystack();
		$this->assertStringContainsString( 'FAIL filesystem', $haystack );
		$this->assertStringContainsString( 'nothing runs', $haystack );
	}

	public function test_foreign_owner_fails_with_chown_recovery(): void {
		CLI::$uid_provider = fn (): int => (int) \fileowner( $this->tmp ) + 40000;

		$this->run_doctor_expecting_error();

		$haystack = $this->log_haystack();
		$this->assertStringContainsString( 'FAIL ownership', $haystack );
		$this->assertStringContainsString( 'chown -R', $haystack );
	}

	public function test_indeterminate_uid_passes_ownership(): void {
		CLI::$uid_provider = static fn (): int => -1;

		( new Worker_CLI_Command() )->doctor( [], [] );

		$this->assertStringNotContainsString( 'FAIL', $this->log_haystack() );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
	}

	public function test_multiple_failures_are_counted(): void {
		Core::$memd                         = null;
		$GLOBALS['_wp_test_next_scheduled'] = false;

		try {
			( new Worker_CLI_Command() )->doctor( [], [] );
			$this->fail( 'Expected WP_CLI::error for failing checks.' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( '2 of 4', $e->getMessage() );
		}
	}
}
