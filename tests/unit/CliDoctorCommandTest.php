<?php
/**
 * Tests for `wp nodes doctor` as the presentation layer for the canonical
 * seven-result Nodes health report.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Config;
use Newspack_Nodes\Health_Checks;
use Newspack_Nodes\Health_Probe_Client;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_CLI_Command;

require_once \dirname( __DIR__, 2 ) . '/includes/cli/class-worker-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( Worker_CLI_Command::class )]
class CliDoctorCommandTest extends TestCase {
	private const CACHE_MESSAGE = 'Cache backend APCu add/read/delete round trip succeeded.';

	private string $tmp;

	private ?\Closure $topology_filter = null;

	private int $http_calls = 0;

	/** @var list<string> */
	private static array $lifecycle_before = [];

	public static function setUpBeforeClass(): void {
		parent::setUpBeforeClass();
		self::$lifecycle_before = self::doctor_temp_directories();
	}

	public static function tearDownAfterClass(): void {
		$lifecycle_after = self::doctor_temp_directories();
		parent::tearDownAfterClass();

		self::assertSame(
			[],
			\array_values( \array_diff( $lifecycle_after, self::$lifecycle_before ) ),
			'Doctor tests must remove every scratch directory they create.'
		);
		self::assertSame(
			[],
			$lifecycle_after,
			'Doctor tests must leave no newspack-nodes-doctor-test-* scratch tree.'
		);
	}

	protected function setUp(): void {
		parent::setUp();

		Health_Probe_Client::$http_call = null;
		Health_Probe_Client::$clock     = null;
		Health_Checks::$remove_probe    = null;
		Health_Checks::$evaluate_alerts = null;

		$GLOBALS['_test_wp_cli_logs']         = [];
		$GLOBALS['_test_wp_cli_warns']        = [];
		$GLOBALS['_test_wp_cli_errors']       = [];
		$GLOBALS['_test_wp_cli_success']      = [];
		// Healthy baseline: the reconciliation cron is scheduled, so the
		// housekeeping result is GOOD and each test drives its own failure.
		$GLOBALS['_wp_test_next_scheduled']   = 1893456789;
		$this->http_calls                     = 0;

		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'newspack-nodes-doctor-test-' );
		$this->use_base_dir(
			$this->tmp,
			[
				'num_partitions'             => 1,
				'alert_lag_threshold'        => 12_345_678,
				'alert_deadletter_threshold' => 5,
			]
		);

		$owner = \fileowner( $this->tmp );
		if ( false === $owner ) {
			throw new \RuntimeException( 'Doctor fixture base-directory owner could not be read.' );
		}
		CLI::$uid_provider = static fn (): int => $owner;

		$this->seed_healthy_worker();
		$this->use_cache_result( Health_Checks::STATUS_GOOD, self::CACHE_MESSAGE );
	}

	protected function tearDown(): void {
		if ( null !== $this->topology_filter ) {
			\remove_action( 'newspack_nodes/topologies', $this->topology_filter );
			$this->topology_filter = null;
		}

		Health_Probe_Client::$http_call = null;
		Health_Probe_Client::$clock     = null;
		Health_Checks::$remove_probe    = null;
		Health_Checks::$evaluate_alerts = null;
		CLI::$uid_provider              = null;
		Topology_Registry::reset();
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );

		unset(
			$GLOBALS['_test_wp_cli_logs'],
			$GLOBALS['_test_wp_cli_warns'],
			$GLOBALS['_test_wp_cli_errors'],
			$GLOBALS['_test_wp_cli_success'],
			$GLOBALS['_wp_test_next_scheduled']
		);

		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** @return list<string> */
	private static function doctor_temp_directories(): array {
		$temp_root = \realpath( \sys_get_temp_dir() );
		if ( false === $temp_root ) {
			throw new \RuntimeException( 'The system temporary directory must resolve for doctor lifecycle checks.' );
		}
		$directories = \glob(
			$temp_root . '/newspack-nodes-test/newspack-nodes-doctor-test-*',
			\GLOB_ONLYDIR
		);
		if ( false === $directories ) {
			throw new \RuntimeException( 'Doctor scratch directories could not be listed.' );
		}
		\sort( $directories );
		return $directories;
	}

	private function seed_healthy_worker(): void {
		$type                  = 'doctor-healthy-7319';
		$this->topology_filter = static function ( array $topologies ) use ( $type ): array {
			$topologies[ $type ] = [
				'topology'       => $type,
				'num_partitions' => 1,
				'stale_timeout'  => 7_319,
			];
			return $topologies;
		};
		\add_filter( 'newspack_nodes/topologies', $this->topology_filter );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ $type ];

		$lock_dir = "{$this->tmp}/locks/{$type}.p0.lock.d";
		if ( ! \mkdir( $lock_dir, 0700, true ) || ! \touch( "{$lock_dir}/heartbeat" ) ) {
			throw new \RuntimeException( 'Healthy doctor worker fixture could not be created.' );
		}

		Config::reset();
		Topology_Registry::reset();
		// A healthy fleet runs the job pool: housekeeping is a job, so a fleet
		// without one is a real degradation the report is expected to name.
		$stock = "{$this->tmp}/stock-topologies";
		if ( ! \mkdir( $stock, 0700, true ) ) {
			throw new \RuntimeException( 'Healthy doctor topology dir could not be created.' );
		}
		\file_put_contents( "{$stock}/{$type}.tsl", "make_node Job_Worker chore-runner\n" );
		Topology_Registry::register_stock_dir( $stock );
	}

	private function seed_consumer_probe( string $reader, string $source, int $distance ): void {
		$dir = "{$this->tmp}/logs/topicprobe.p0";
		if ( ! \is_dir( $dir ) && ! \mkdir( $dir, 0700, true ) ) {
			throw new \RuntimeException( 'Doctor consumer-probe fixture directory could not be created.' );
		}

		$record                                 = [];
		$record[ Probe_Record::SOURCE ]         = $source;
		$record[ Probe_Record::READER ]         = $reader;
		$record[ Probe_Record::CURSOR_SEGMENT ] = 0;
		$record[ Probe_Record::CURSOR_OFF ]     = 0;
		$record[ Probe_Record::END_SEGMENT ]    = 0;
		$record[ Probe_Record::END_SIZE ]       = 0;
		$record[ Probe_Record::DISTANCE ]       = $distance;
		$record[ Probe_Record::MSGS_DELTA ]           = 8_843;

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $record;
		$written                   = \file_put_contents(
			"{$dir}/0.log",
			Message::packed( $message ) . "\n",
			\FILE_APPEND
		);
		if ( false === $written ) {
			throw new \RuntimeException( 'Doctor consumer-probe fixture could not be written.' );
		}
	}

	private function use_cache_result( string $status, string $message ): void {
		$body = \wp_json_encode(
			[
				'id'       => Health_Checks::CACHE_ID,
				'label'    => Health_Checks::CACHE_LABEL,
				'status'   => $status,
				'messages' => [ $message ],
			]
		);
		if ( ! \is_string( $body ) ) {
			throw new \RuntimeException( 'Doctor cache-response fixture could not be encoded.' );
		}

		Health_Probe_Client::$clock     = static fn (): int => 1_756_423_719;
		Health_Probe_Client::$http_call = function ( string $_url, array $_args ) use ( $body ): array {
			++$this->http_calls;
			return [
				'response' => [ 'code' => 200 ],
				'body'     => $body,
			];
		};
	}

	private function run_doctor_expecting_exit_zero(): void {
		try {
			( new Worker_CLI_Command() )->doctor( [], [] );
		} catch ( \Throwable $e ) {
			$this->fail( $e->getMessage() . "\n" . $this->log_haystack() );
		}
	}

	private function log_haystack(): string {
		return \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
	}

	public function test_clean_report_renders_exactly_eight_canonical_ok_rows_and_exits_zero(): void {
		$this->run_doctor_expecting_exit_zero();

		$ids = [
			'cache-backend',
			'filesystem',
			'ownership',
			'housekeeping',
			'config-keys',
			'worker-liveness',
			'consumer-lag',
			'dead-letters',
		];
		$this->assertCount( 8, $GLOBALS['_test_wp_cli_logs'] );
		foreach ( $ids as $index => $id ) {
			$this->assertStringStartsWith( "ok   {$id} — ", $GLOBALS['_test_wp_cli_logs'][ $index ] );
			$this->assertSame( 1, \substr_count( $this->log_haystack(), " {$id} — " ), $id );
		}
		$this->assertSame( 8, \count( \preg_grep( '/^ok   /', $GLOBALS['_test_wp_cli_logs'] ) ) );
		$this->assertSame( 'ok   cache-backend — ' . self::CACHE_MESSAGE, $GLOBALS['_test_wp_cli_logs'][0] );
		$this->assertStringNotContainsString( 'wp-cron', $this->log_haystack() );
		$this->assertSame( [ 'All 8 Nodes health checks passed.' ], $GLOBALS['_test_wp_cli_success'] );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_warns'] );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_errors'] );
		$this->assertSame( 1, $this->http_calls );
	}

	public function test_recommendation_renders_warn_summary_and_exits_zero(): void {
		$message = 'Web cache probe recommendation 8843.';
		$this->use_cache_result( Health_Checks::STATUS_RECOMMENDED, $message );

		$this->run_doctor_expecting_exit_zero();

		$this->assertSame( "WARN cache-backend — {$message}", $GLOBALS['_test_wp_cli_logs'][0] );
		$this->assertSame( [ '1 of 8 Nodes health checks need attention.' ], $GLOBALS['_test_wp_cli_warns'] );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_errors'] );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_success'] );
		$this->assertSame( 1, $this->http_calls );
	}

	public function test_critical_result_renders_fail_summary_and_exits_one(): void {
		$message = 'Web cache probe critical result 6421.';
		$this->use_cache_result( Health_Checks::STATUS_CRITICAL, $message );

		$thrown = null;
		try {
			( new Worker_CLI_Command() )->doctor( [], [] );
		} catch ( \Throwable $e ) {
			$thrown = $e;
		}

		$this->assertInstanceOf( \RuntimeException::class, $thrown );
		$this->assertSame( "FAIL cache-backend — {$message}", $GLOBALS['_test_wp_cli_logs'][0] );
		$this->assertSame( [ '1 of 8 Nodes health checks failed.' ], $GLOBALS['_test_wp_cli_errors'] );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_warns'] );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_success'] );
		$this->assertSame( 1, $this->http_calls );
	}

	public function test_additional_alert_messages_render_as_indented_continuations(): void {
		$this->seed_consumer_probe( 'doctor-reader-a-7319.p0', 'doctor-source-a-7319.p0', 12_345_679 );
		$this->seed_consumer_probe( 'doctor-reader-b-7319.p0', 'doctor-source-b-7319.p0', 12_345_681 );

		$this->run_doctor_expecting_exit_zero();

		$this->assertContains(
			'WARN consumer-lag — Consumer doctor-reader-a-7319.p0 is 12345679 bytes behind on doctor-source-a-7319.p0.',
			$GLOBALS['_test_wp_cli_logs']
		);
		$this->assertContains(
			'     Consumer doctor-reader-b-7319.p0 is 12345681 bytes behind on doctor-source-b-7319.p0.',
			$GLOBALS['_test_wp_cli_logs']
		);
		$this->assertSame( [ '1 of 8 Nodes health checks need attention.' ], $GLOBALS['_test_wp_cli_warns'] );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_errors'] );
	}
}
