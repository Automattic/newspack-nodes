<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversNothing;
use Newspack_Nodes\Tests\TestCase;

/**
 * Each test process runs on a base directory of its own, so one suite's
 * teardown can never delete another's live Tables or locks.
 */
#[CoversNothing]
class TestBaseDirTest extends TestCase {

	/** @var list<string> Base dirs the child processes created. */
	private array $child_bases = [];

	protected function tearDown(): void {
		foreach ( $this->child_bases as $base ) {
			$this->rmdir_recursive( $base );
		}
		parent::tearDown();
	}

	/**
	 * Bootstrap in a fresh PHP process and report its pid and resolved base.
	 *
	 * @param array<string,string> $env Extra environment for the child.
	 * @return array{pid:string,base:string}
	 */
	private function child_base( array $env = [] ): array {
		$script = 'require ' . \var_export( \dirname( __DIR__ ) . '/bootstrap.php', true ) . ';'
			. ' $base = \Newspack_Nodes\Config::get_base_directory();'
			. ' @\mkdir( $base, 0700, true ); \touch( $base . "/kea-8813" );'
			. ' echo \getmypid(), "\n", $base;';
		$child_env = \getenv();
		unset( $child_env['NEWSPACK_TEST_BASE_DIR'], $child_env['LOCAL_NEWSPACK_NODES_CONF'] );
		$process = \proc_open(
			[ \PHP_BINARY, '-r', $script ],
			[ 1 => [ 'pipe', 'w' ], 2 => [ 'pipe', 'w' ] ],
			$pipes,
			null,
			$env + $child_env
		);
		$this->assertIsResource( $process );
		$out = (string) \stream_get_contents( $pipes[1] );
		$err = (string) \stream_get_contents( $pipes[2] );
		\fclose( $pipes[1] );
		\fclose( $pipes[2] );
		$this->assertSame( 0, \proc_close( $process ), $err );
		[ $pid, $base ] = \array_pad( \explode( "\n", $out, 2 ), 2, '' );
		$this->child_bases[] = $base;
		return [
			'pid'  => $pid,
			'base' => $base,
		];
	}

	public function test_two_bootstraps_in_different_processes_get_different_bases(): void {
		$first  = $this->child_base();
		$second = $this->child_base();

		$this->assertNotSame( $first['base'], $second['base'] );
		$this->assertStringEndsWith( '/newspack-nodes-test-' . $first['pid'], $first['base'] );
		$this->assertStringEndsWith( '/newspack-nodes-test-' . $second['pid'], $second['base'] );
	}

	/** A base the bootstrap named is its own to remove, so a finished run leaves none. */
	public function test_a_bootstrap_removes_the_base_it_named_when_its_process_exits(): void {
		$this->assertDirectoryDoesNotExist( $this->child_base()['base'] );
	}

	/** A base a consumer named is the consumer's: the substrate leaves it. */
	public function test_a_bootstrap_leaves_a_base_it_did_not_name(): void {
		$named = $this->make_temp_dir( 'kea-named-8813-' );

		$this->child_base( [ 'NEWSPACK_TEST_BASE_DIR' => $named ] );

		$this->assertFileExists( $named . '/kea-8813' );
	}

	/** A consumer's bootstrap names the base first, and the substrate keeps it. */
	public function test_a_base_already_named_in_the_environment_is_kept(): void {
		$named = (string) \realpath( \sys_get_temp_dir() ) . '/newspack-kea-test-8813';

		$this->assertSame( $named, $this->child_base( [ 'NEWSPACK_TEST_BASE_DIR' => $named ] )['base'] );
	}

	/**
	 * Tearing down restores the config the process booted with — a consumer's
	 * own, when its bootstrap named one — never the substrate's fixed file.
	 */
	public function test_teardown_restores_the_config_the_process_booted_with(): void {
		$booted = self::$booted_conf;
		$kea    = $this->make_temp_dir( 'kea-conf-8813-' ) . '/kea-test-config.php';
		try {
			self::$booted_conf = $kea;
			$this->use_base_dir( $this->make_temp_dir( 'kea-base-8813-' ) );

			$this->tearDown();

			$this->assertSame( $kea, \getenv( 'LOCAL_NEWSPACK_NODES_CONF' ) );
		} finally {
			self::$booted_conf = $booted;
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $booted );
			$this->setUp();
		}
	}
}
