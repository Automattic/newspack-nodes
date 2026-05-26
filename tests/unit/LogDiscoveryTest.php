<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Disk-discovery primitive — readdir `{base}/logs/*.log/` and return the
 * basename list. Replaces the application's hardcoded log catalogs +
 * `num_logs` filter callback (which used to return `$count + 6`).
 */
#[CoversClass( Log_Discovery::class )]
class LogDiscoveryTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'log-discovery-' );
		$this->use_base_dir( $this->tmp );
		Log_Discovery::reset();
		// Other tests in the suite wipe `$GLOBALS['_wp_actions']` to isolate,
		// which drops the boot-time `add_action(Config::RESET_ACTION, ...)`
		// registration from `newspack-nodes.php`. Re-register here so the
		// behavior under test (Log_Discovery responds to config-reset) stays
		// observable regardless of test order. The boot-time registration
		// itself is a one-liner; if it disappears from production we'll catch
		// it via browser smoke / integration coverage, not here.
		\add_action( Config::RESET_ACTION, [ Log_Discovery::class, 'reset' ] );
	}

	protected function tearDown(): void {
		Log_Discovery::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_returns_empty_when_logs_dir_missing(): void {
		// No `{base}/logs/` directory at all — discovery returns empty, not error.
		$this->assertSame( [], Log_Discovery::on_disk() );
	}

	public function test_returns_basenames_without_log_suffix(): void {
		\mkdir( "{$this->tmp}/logs/firehose.log", 0755, true );
		\mkdir( "{$this->tmp}/logs/errors.log", 0755, true );

		$this->assertSame( [ 'errors', 'firehose' ], Log_Discovery::on_disk() );
	}

	public function test_results_are_sorted_alphabetically(): void {
		\mkdir( "{$this->tmp}/logs/zeta.log", 0755, true );
		\mkdir( "{$this->tmp}/logs/alpha.log", 0755, true );
		\mkdir( "{$this->tmp}/logs/middle.log", 0755, true );

		$this->assertSame( [ 'alpha', 'middle', 'zeta' ], Log_Discovery::on_disk() );
	}

	public function test_ignores_non_dir_entries(): void {
		\mkdir( "{$this->tmp}/logs", 0755, true );
		// Stray file with .log suffix at the wrong level — not a partition dir.
		\file_put_contents( "{$this->tmp}/logs/stray.log", '' );
		\mkdir( "{$this->tmp}/logs/real.log", 0755, true );

		$this->assertSame( [ 'real' ], Log_Discovery::on_disk() );
	}

	public function test_memoizes_within_process(): void {
		\mkdir( "{$this->tmp}/logs/firehose.log", 0755, true );
		$first = Log_Discovery::on_disk();

		// Add a new log dir AFTER first call. Without memoization the second
		// call would pick it up; with memoization, the cached result wins.
		\mkdir( "{$this->tmp}/logs/late.log", 0755, true );
		$second = Log_Discovery::on_disk();

		$this->assertSame( $first, $second );
		$this->assertSame( [ 'firehose' ], $second );
	}

	public function test_reset_clears_cache(): void {
		\mkdir( "{$this->tmp}/logs/firehose.log", 0755, true );
		$this->assertSame( [ 'firehose' ], Log_Discovery::on_disk() );

		\mkdir( "{$this->tmp}/logs/late.log", 0755, true );
		Log_Discovery::reset();

		$this->assertSame( [ 'firehose', 'late' ], Log_Discovery::on_disk() );
	}

	public function test_config_reset_action_clears_cache(): void {
		// Workers that survive a `Config::reset()` need their on-disk view to
		// invalidate so newly-added logs become visible. setUp() re-registers
		// the callback (bootstrap-time registration is wiped by sibling tests);
		// this test pins the behavior the wiring enables.
		\mkdir( "{$this->tmp}/logs/firehose.log", 0755, true );
		$this->assertSame( [ 'firehose' ], Log_Discovery::on_disk() );

		\mkdir( "{$this->tmp}/logs/late.log", 0755, true );
		\do_action( Config::RESET_ACTION );

		$this->assertSame( [ 'firehose', 'late' ], Log_Discovery::on_disk() );
	}

	public function test_on_disk_propagates_throw_when_base_directory_unconfigured(): void {
		// No silent `/tmp/newspack-nodes` fallback: when base_directory is
		// unconfigured, on_disk() must propagate Config::get_base_directory()'s
		// RuntimeException rather than globbing a phantom default tree.
		$conf = "{$this->tmp}/empty-base.php";
		\file_put_contents( $conf, "<?php\nreturn [ 'base_directory' => '' ];\n" );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		\update_option( 'newspack_nodes_base_directory', '' );
		Config::reset();
		Log_Discovery::reset();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/base_directory not configured/' );
		Log_Discovery::on_disk();
	}
}
