<?php
/**
 * HealthChecksTest: the canonical environment and fleet health evaluator.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Alerts;
use Newspack_Nodes\Health_Checks;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;

#[CoversClass( Health_Checks::class )]
class HealthChecksTest extends TestCase {

	private string $tmp;

	/** @var array<int,string> */
	private array $worker_types = [];

	/** @var list<\Closure> */
	private array $topology_filters = [];

	/** @var list<string> */
	private array $refused_base_links = [];

	/** @var array{directories:list<string>,topology_filters:list<callable>} */
	private static array $lifecycle_before = [];

	public static function setUpBeforeClass(): void {
		parent::setUpBeforeClass();
		self::$lifecycle_before = self::lifecycle_state();
	}

	public static function tearDownAfterClass(): void {
		$lifecycle_after = self::lifecycle_state();
		parent::tearDownAfterClass();
		self::assertSame(
			self::$lifecycle_before,
			$lifecycle_after,
			'Health-check tests must not leak temporary directories or topology filters.'
		);
	}

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'newspack-nodes-health-checks-test-' );
		$this->use_base_dir(
			$this->tmp,
			[
				'num_partitions'             => 1,
				'alert_lag_threshold'        => 12_345_678,
				'alert_deadletter_threshold' => 5,
			]
		);
		$owner             = (int) \fileowner( $this->tmp );
		CLI::$uid_provider = static fn (): int => $owner;
	}

	protected function tearDown(): void {
		foreach ( $this->topology_filters as $filter ) {
			\remove_action( 'newspack_nodes/topologies', $filter );
		}
		$this->topology_filters = [];
		if ( \class_exists( Health_Checks::class ) ) {
			Health_Checks::$remove_probe = null;
			if ( \property_exists( Health_Checks::class, 'evaluate_alerts' ) ) {
				Health_Checks::$evaluate_alerts = null;
			}
		}
		CLI::$uid_provider = null;
		Topology_Registry::reset();
		foreach ( $this->refused_base_links as $link ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink -- Removes this test's registered symlink before recursive fixture cleanup.
			if ( \is_link( $link ) && ! \unlink( $link ) ) {
				throw new \RuntimeException( "Refused-base fixture symlink could not be removed: {$link}" );
			}
		}
		$this->refused_base_links = [];
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** @return array{directories:list<string>,topology_filters:list<callable>} */
	private static function lifecycle_state(): array {
		$temp_root = \realpath( \sys_get_temp_dir() );
		if ( false === $temp_root ) {
			throw new \RuntimeException( 'The system temporary directory must resolve for lifecycle checks.' );
		}
		$directories = \glob(
			$temp_root . '/newspack-nodes-test/newspack-nodes-health-checks-test-' . \getmypid() . '-*',
			GLOB_ONLYDIR
		);
		if ( false === $directories ) {
			throw new \RuntimeException( 'Health-check temporary directories could not be listed.' );
		}
		\sort( $directories );
		return [
			'directories'      => $directories,
			'topology_filters' => $GLOBALS['_wp_actions']['newspack_nodes/topologies'] ?? [],
		];
	}

	/** @return array{id:string,label:string,status:string,messages:array<int,string>} */
	private function good_cache_result(): array {
		return [
			'id'       => Health_Checks::CACHE_ID,
			'label'    => Health_Checks::CACHE_LABEL,
			'status'   => Health_Checks::STATUS_GOOD,
			'messages' => [ 'Web cache probe 7319 succeeded.' ],
		];
	}

	/**
	 * @param array<int,array{id:string,label:string,status:string,messages:array<int,string>}> $results
	 * @return array<string,array{id:string,label:string,status:string,messages:array<int,string>}>
	 */
	private function by_id( array $results ): array {
		$by_id = [];
		foreach ( $results as $result ) {
			$by_id[ $result['id'] ] = $result;
		}
		return $by_id;
	}

	private function seed_worker( string $type, ?int $heartbeat_age ): void {
		$this->worker_types[] = $type;
		$filter               = static function ( array $topologies ) use ( $type ): array {
			$topologies[ $type ] = [
				'topology'       => $type,
				'num_partitions' => 1,
				'stale_timeout'  => 60,
			];
			return $topologies;
		};
		$this->topology_filters[] = $filter;
		\add_filter( 'newspack_nodes/topologies', $filter );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = $this->worker_types;
		if ( null !== $heartbeat_age ) {
			$lock_dir = "{$this->tmp}/locks/{$type}.p0.lock.d";
			\mkdir( $lock_dir, 0700, true );
			\touch( "{$lock_dir}/heartbeat", \time() - $heartbeat_age );
		}
		Config::reset();
		Topology_Registry::reset();
	}

	private function seed_consumer_probe( string $reader, string $source, int $distance ): void {
		$dir = "{$this->tmp}/logs/topicprobe.p0";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0700, true );
		}
		$record                                 = [];
		$record[ Probe_Record::SOURCE ]         = $source;
		$record[ Probe_Record::READER ]         = $reader;
		$record[ Probe_Record::CURSOR_SEGMENT ] = 0;
		$record[ Probe_Record::CURSOR_OFF ]     = 0;
		$record[ Probe_Record::END_SEGMENT ]    = 0;
		$record[ Probe_Record::END_SIZE ]       = 0;
		$record[ Probe_Record::DISTANCE ]       = $distance;
		$record[ Probe_Record::MSGS_DELTA ]           = 7319;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $record;
		\file_put_contents( "{$dir}/0.log", Message::packed( $message ) . "\n", FILE_APPEND );
	}

	private function seed_deadletters( string $reader, int $count ): void {
		$dir = "{$this->tmp}/deadletter/{$reader}";
		\mkdir( $dir, 0700, true );
		for ( $segment = 0; $segment < $count; ++$segment ) {
			\file_put_contents( "{$dir}/{$segment}.log", 'health-deadletter-7319' );
		}
	}

	private function use_refused_base_directory( string $suffix ): void {
		$target = "{$this->tmp}/target-{$suffix}";
		$link   = "{$this->tmp}/refused-link-{$suffix}";
		\mkdir( $target, 0700 );
		\symlink( $target, $link );
		$this->refused_base_links[] = $link;
		$config_file = "{$this->tmp}/refused-config-{$suffix}.php";
		\file_put_contents(
			$config_file,
			"<?php\nreturn " . \var_export(
				[
					'base_directory'             => $link,
					'num_partitions'             => 1,
					'alert_lag_threshold'        => 12_345_678,
					'alert_deadletter_threshold' => 5,
				],
				true
			) . ";\n"
		);
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $config_file );
		Config::reset();
	}

	/**
	 * @param array<int,mixed> $alerts
	 * @return array<int,array{id:string,label:string,status:string,messages:array<int,string>}>
	 */
	private function fleet_results_from_alerts( array $alerts ): array {
		$method = new \ReflectionMethod( Health_Checks::class, 'fleet_results' );
		return $method->invoke( null, $alerts );
	}

	public function test_health_checks_class_exists(): void {
		$this->assertTrue(
			\class_exists( 'Newspack_Nodes\\Health_Checks' ),
			'The canonical health evaluator must be autoloadable.'
		);
	}

	// ── housekeeping: the reconcile cron it now depends on ─────────────────

	/** Register a stock topology dir and activate $names, with $tsl contents. */
	private function activate_topologies( array $tsl ): void {
		$stock = $this->make_temp_dir( 'health-housekeeping-stock-' );
		foreach ( $tsl as $name => $contents ) {
			\file_put_contents( "{$stock}/{$name}.tsl", $contents );
		}
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = \array_keys( $tsl );
		Config::reset();
	}

	public function test_housekeeping_is_good_when_the_reconcile_cron_is_scheduled(): void {
		// A timestamp no default shares — `false` is the missing-event value.
		$GLOBALS['_wp_test_next_scheduled'] = 1893456789;
		$this->activate_topologies( [ 'ledger-lab' => "make_node Echo relay\n" ] );

		$result = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) )['housekeeping'];

		$this->assertSame( Health_Checks::STATUS_GOOD, $result['status'] );
		$GLOBALS['_wp_test_next_scheduled'] = false;
	}

	public function test_housekeeping_is_critical_when_the_reconcile_cron_is_missing(): void {
		// The cron pass is now the ONLY thing that runs retention, orphan
		// partition/IPC reaping, alert emission, the delayed-jobs sweep and every
		// `periodic` subscriber — and it is the cold-start revival tier besides.
		// A vetoed or cleared event stops all of it while every other check
		// stays green.
		$GLOBALS['_wp_test_next_scheduled'] = false;
		$this->activate_topologies( [ 'ledger-lab' => "make_node Echo relay\n" ] );

		$result = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) )['housekeeping'];

		$this->assertSame( Health_Checks::STATUS_CRITICAL, $result['status'] );
		$this->assertStringContainsString( 'newspack_nodes/reconcile', $result['messages'][0] );
	}

	public function test_housekeeping_is_good_when_nothing_is_active(): void {
		// No workers means no logs growing and nothing to keep house for; the
		// fleet checks report the empty fleet vacuously good for the same reason.
		$GLOBALS['_wp_test_next_scheduled'] = false;
		$this->activate_topologies( [] );

		$result = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) )['housekeeping'];

		$this->assertSame( Health_Checks::STATUS_GOOD, $result['status'] );
	}

	/**
	 * A held fleet is indistinguishable from a broken one, and the failure mode
	 * is a forgotten `wp nodes start` — so the hold reports itself, with its age.
	 * Site Health and `wp nodes doctor` both render `evaluate()`, so declaring it
	 * once here keeps the two in sync by construction.
	 */
	public function test_a_held_fleet_reports_itself_with_its_age(): void {
		\Newspack_Nodes\Spawn_Coordinator::set_hold( \time() - 7200 );

		$results = Health_Checks::evaluate();

		$by_id = \array_column( $results, null, 'id' );
		$this->assertArrayHasKey( 'fleet-hold', $by_id );
		$this->assertSame( Health_Checks::STATUS_RECOMMENDED, $by_id['fleet-hold']['status'] );
		$this->assertStringContainsString( '2h', $by_id['fleet-hold']['messages'][0] );
		$this->assertStringContainsString( 'wp nodes start', $by_id['fleet-hold']['messages'][0] );

		\Newspack_Nodes\Spawn_Coordinator::clear_hold();
	}

	/** No hold, no row — the check is a reminder, not a permanent status line. */
	public function test_an_unheld_fleet_reports_no_hold_row(): void {
		$results = Health_Checks::evaluate();
		$this->assertNotContains( 'fleet-hold', \array_column( $results, 'id' ) );
	}

	public function test_evaluate_returns_exactly_the_seven_results_in_canonical_order(): void {
		$results = Health_Checks::evaluate(
			[
				'id'       => 'cache-backend',
				'label'    => 'Cache backend',
				'status'   => 'good',
				'messages' => [ 'Web cache probe 7319 succeeded.' ],
			]
		);

		$this->assertSame(
			[
				'cache-backend',
				'filesystem',
				'ownership',
				'housekeeping',
				'worker-liveness',
				'consumer-lag',
				'dead-letters',
			],
			\array_column( $results, 'id' )
		);
		$this->assertSame(
			[
				'Cache backend',
				'Filesystem',
				'Ownership',
				'Housekeeping',
				'Worker liveness',
				'Consumer lag',
				'Dead letters',
			],
			\array_column( $results, 'label' )
		);
		$this->assertSame(
			\array_fill( 0, 7, [ 'id', 'label', 'messages', 'status' ] ),
			\array_map(
				static function ( array $result ): array {
					$keys = \array_keys( $result );
					\sort( $keys );
					return $keys;
				},
				$results
			)
		);
	}

	public function test_memcached_round_trip_is_good_and_names_the_selected_backend(): void {
		Core::$memd = new InMemoryMemcached();

		$result = Health_Checks::cache_backend();

		$this->assertSame( 'good', $result['status'] );
		$this->assertStringContainsString( 'Memcached', $result['messages'][0] );
	}

	public function test_apcu_only_round_trip_is_good_and_names_the_selected_backend(): void {
		if ( ! \function_exists( 'apcu_enabled' ) || ! \apcu_enabled() ) {
			$this->markTestSkipped( 'CLI APCu is required for the real cache probe.' );
		}
		Core::$memd                 = null;
		Cache_Backend::$apcu_usable = null;

		$result = Health_Checks::cache_backend();

		$this->assertSame( 'good', $result['status'] );
		$this->assertStringContainsString( 'APCu', $result['messages'][0] );
	}

	public function test_no_backend_is_critical(): void {
		Core::$memd                 = null;
		Cache_Backend::$apcu_usable = static fn (): bool => false;

		$result = Health_Checks::cache_backend();

		$this->assertSame( 'critical', $result['status'] );
		$this->assertStringContainsString( 'No cache backend', $result['messages'][0] );
	}

	public function test_failed_selected_backend_add_is_critical(): void {
		Core::$memd = new class() extends InMemoryMemcached {
			public function add( string $key, mixed $value, int $expiration = 0 ): bool {
				return false;
			}
		};

		$result = Health_Checks::cache_backend();

		$this->assertSame( 'critical', $result['status'] );
		$this->assertStringContainsString( 'add', $result['messages'][0] );
	}

	public function test_failed_selected_backend_read_is_critical(): void {
		Core::$memd = new class() extends InMemoryMemcached {
			public function add( string $key, mixed $value, int $expiration = 0 ): bool {
				return parent::set( $key, $value, $expiration );
			}

			public function get( string $key, ?callable $cache_cb = null, int $get_flags = 0 ): mixed {
				return false;
			}

			public function getResultCode(): int {
				return \Memcached::RES_FAILURE;
			}
		};

		$result = Health_Checks::cache_backend();

		$this->assertSame( 'critical', $result['status'] );
		$this->assertStringContainsString( 'read', $result['messages'][0] );
	}

	public function test_wrong_selected_backend_value_is_critical(): void {
		Core::$memd = new class() extends InMemoryMemcached {
			public function add( string $key, mixed $value, int $expiration = 0 ): bool {
				return parent::set( $key, $value, $expiration );
			}

			public function get( string $key, ?callable $cache_cb = null, int $get_flags = 0 ): mixed {
				return 'wrong-cache-value-7319';
			}

			public function getResultCode(): int {
				return \Memcached::RES_SUCCESS;
			}
		};

		$result = Health_Checks::cache_backend();

		$this->assertSame( 'critical', $result['status'] );
		$this->assertStringContainsString( 'read', $result['messages'][0] );
	}

	public function test_cache_delete_failure_is_critical_and_cleanup_is_retried(): void {
		$memd = new class() extends InMemoryMemcached {
			public int $delete_calls = 0;

			public function delete( string $key, int $time = 0 ): bool {
				++$this->delete_calls;
				return false;
			}
		};
		Core::$memd = $memd;

		$result = Health_Checks::cache_backend();

		$this->assertSame( 'critical', $result['status'] );
		$this->assertStringContainsString( 'delete', $result['messages'][0] );
		$this->assertSame( 2, $memd->delete_calls, 'The finally cleanup retries the failed delete exactly once.' );
	}

	public function test_clean_report_has_one_nonempty_affirmative_message_per_result(): void {
		$results = Health_Checks::evaluate( $this->good_cache_result() );

		foreach ( $results as $result ) {
			$this->assertSame( 'good', $result['status'], $result['id'] );
			$this->assertCount( 1, $result['messages'], $result['id'] );
			$this->assertNotSame( '', $result['messages'][0], $result['id'] );
		}
	}

	public function test_filesystem_probe_remove_failure_is_critical(): void {
		$removed_path                = '';
		Health_Checks::$remove_probe = static function ( string $path ) use ( &$removed_path ): bool {
			$removed_path = $path;
			return false;
		};

		$results = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) );

		$this->assertSame( 'critical', $results['filesystem']['status'] );
		$this->assertStringContainsString( 'could not be removed', $results['filesystem']['messages'][0] );
		$this->assertFileExists( $removed_path );
	}

	public function test_unresolved_base_directory_makes_environment_critical_and_fleet_unknown(): void {
		$this->use_refused_base_directory( '7319' );

		$results = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) );

		$this->assertSame( 'critical', $results['filesystem']['status'] );
		$this->assertSame( 'critical', $results['ownership']['status'] );
		foreach ( [ 'worker-liveness', 'consumer-lag', 'dead-letters' ] as $id ) {
			$this->assertSame( 'recommended', $results[ $id ]['status'], $id );
			$this->assertStringContainsString( 'could not be evaluated', $results[ $id ]['messages'][0], $id );
		}
	}

	public function test_refused_base_directory_keeps_ownership_critical_when_uid_is_unavailable(): void {
		$this->use_refused_base_directory( 'unavailable-9871' );
		CLI::$uid_provider = static fn (): int => -1;
		Config::reset();

		$results = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) );

		$this->assertSame( 'critical', $results['ownership']['status'] );
		$this->assertStringContainsString( 'could not make the configured path usable', $results['ownership']['messages'][0] );
	}

	public function test_foreign_owner_is_critical_and_includes_chown_guidance(): void {
		$owner             = (int) \fileowner( $this->tmp );
		CLI::$uid_provider = static fn (): int => $owner + 40_731;
		Config::reset();

		$results = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) );

		$this->assertSame( 'critical', $results['ownership']['status'] );
		$this->assertStringContainsString( 'chown -R', $results['ownership']['messages'][0] );
	}

	public function test_unavailable_effective_uid_is_recommended(): void {
		CLI::$uid_provider = static fn (): int => -1;
		Config::reset();

		$results = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) );

		$this->assertSame( 'recommended', $results['ownership']['status'] );
		$this->assertStringContainsString( 'could not be verified', $results['ownership']['messages'][0] );
	}

	public function test_worker_family_preserves_missing_and_stale_messages_and_is_critical(): void {
		$this->seed_worker( 'health-missing-7319', null );
		$this->seed_worker( 'health-stale-7319', 120 );

		$results = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) );

		$this->assertSame( 'critical', $results['worker-liveness']['status'] );
		$this->assertCount( 2, $results['worker-liveness']['messages'] );
		$messages = \implode( "\n", $results['worker-liveness']['messages'] );
		$this->assertStringContainsString( 'health-missing-7319.p0', $messages );
		$this->assertStringContainsString( 'health-stale-7319.p0', $messages );
	}

	public function test_consumer_family_preserves_two_messages_above_configured_threshold(): void {
		$this->seed_consumer_probe( 'health-reader-a-7319.p0', 'health-source-a-7319.p0', 12_345_679 );
		$this->seed_consumer_probe( 'health-reader-b-7319.p0', 'health-source-b-7319.p0', 12_345_681 );

		$results = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) );

		$this->assertSame( 'recommended', $results['consumer-lag']['status'] );
		$this->assertCount( 2, $results['consumer-lag']['messages'] );
		$messages = \implode( "\n", $results['consumer-lag']['messages'] );
		$this->assertStringContainsString( 'health-reader-a-7319.p0', $messages );
		$this->assertStringContainsString( '12345679', $messages );
		$this->assertStringContainsString( 'health-reader-b-7319.p0', $messages );
		$this->assertStringContainsString( '12345681', $messages );
	}

	public function test_deadletter_family_preserves_two_messages_above_configured_threshold(): void {
		$this->seed_deadletters( 'health-jobs-a-7319.p0', 6 );
		$this->seed_deadletters( 'health-jobs-b-7319.p0', 8 );

		$results = $this->by_id( Health_Checks::evaluate( $this->good_cache_result() ) );

		$this->assertSame( 'recommended', $results['dead-letters']['status'] );
		$this->assertCount( 2, $results['dead-letters']['messages'] );
		$messages = \implode( "\n", $results['dead-letters']['messages'] );
		$this->assertStringContainsString( '6 dead-letter', $messages );
		$this->assertStringContainsString( 'health-jobs-a-7319.p0', $messages );
		$this->assertStringContainsString( '8 dead-letter', $messages );
		$this->assertStringContainsString( 'health-jobs-b-7319.p0', $messages );
	}

	public function test_fleet_alerts_require_nonempty_string_fields(): void {
		$valid = [
			'key'      => 'worker_missing:health-7319.p0',
			'message'  => 'Worker health-7319.p0 is not running.',
			'severity' => 'warning',
		];
		$cases = [
			'missing key'       => [ \array_diff_key( $valid, [ 'key' => true ] ), 'key' ],
			'non-string key'    => [ \array_replace( $valid, [ 'key' => 7319 ] ), 'key' ],
			'empty key'         => [ \array_replace( $valid, [ 'key' => '' ] ), 'key' ],
			'empty message'     => [ \array_replace( $valid, [ 'message' => '' ] ), 'message' ],
			'missing message'   => [ \array_diff_key( $valid, [ 'message' => true ] ), 'message' ],
			'non-string message' => [ \array_replace( $valid, [ 'message' => [ 'health-9871' ] ] ), 'message' ],
			'non-string severity' => [ \array_replace( $valid, [ 'severity' => [ 'warning' ] ] ), 'severity' ],
			'empty severity'    => [ \array_replace( $valid, [ 'severity' => '' ] ), 'severity' ],
			'missing severity'  => [ \array_diff_key( $valid, [ 'severity' => true ] ), 'severity' ],
		];

		foreach ( $cases as $name => [ $alert, $field ] ) {
			try {
				$this->fleet_results_from_alerts( [ $alert ] );
				$this->fail( "{$name} must fail loudly." );
			} catch ( \UnexpectedValueException $e ) {
				$this->assertStringContainsString( $field, $e->getMessage(), $name );
			}
		}
	}

	public function test_alerts_evaluator_is_not_called_when_base_directory_is_unresolved(): void {
		$this->assertTrue(
			\property_exists( Health_Checks::class, 'evaluate_alerts' ),
			'Health checks need one narrow Alerts evaluator seam.'
		);
		$calls                          = 0;
		Health_Checks::$evaluate_alerts = static function () use ( &$calls ): array {
			++$calls;
			return [];
		};
		$this->use_refused_base_directory( 'alerts-skipped-6421' );

		Health_Checks::evaluate( $this->good_cache_result() );

		$this->assertSame( 0, $calls );
	}

	public function test_alerts_evaluator_is_called_exactly_once_when_base_directory_resolves(): void {
		$calls                          = 0;
		Health_Checks::$evaluate_alerts = static function () use ( &$calls ): array {
			++$calls;
			return [];
		};

		Health_Checks::evaluate( $this->good_cache_result() );

		$this->assertSame( 1, $calls );
	}

	public function test_fleet_alert_rejects_unknown_severity(): void {
		$this->expectException( \UnexpectedValueException::class );
		$this->expectExceptionMessage( 'invalid severity' );

		$this->fleet_results_from_alerts(
			[
				[
					'key'      => 'worker_missing:health-7319.p0',
					'message'  => 'Worker health-7319.p0 is not running.',
					'severity' => 'resolved',
				],
			]
		);
	}

	public function test_an_unrecognized_alert_family_surfaces_instead_of_fataling(): void {
		// Site Health and `wp nodes doctor` both call this. A throw here loses
		// the WHOLE environment report — cache, filesystem, ownership — because
		// one alert row was new. Adding an alert kind must never do that.
		$results = $this->fleet_results_from_alerts(
			[
				[
					'key'      => 'invented-health-family:7319',
					'family'   => 'invented-health-family',
					'message'  => 'Invented health alert 7319.',
					'severity' => 'warning',
				],
			]
		);

		$other = null;
		foreach ( $results as $result ) {
			if ( 'other-alerts' === $result['id'] ) {
				$other = $result;
			}
		}
		$this->assertNotNull( $other, 'an unrecognized family gets its own result' );
		$this->assertContains( 'Invented health alert 7319.', $other['messages'] );

		// The three known families still report, so nothing else is lost.
		$ids = \array_column( $results, 'id' );
		foreach ( [ 'worker-liveness', 'consumer-lag', 'dead-letters' ] as $id ) {
			$this->assertContains( $id, $ids );
		}
	}

	public function test_alerts_declare_their_family_rather_than_encoding_it_in_the_key(): void {
		// Health_Checks used to re-derive the taxonomy by str_starts_with on
		// the key, so renaming a key prefix for readability fataled Site Health.
		$rows = [
			'consumer_lag:reader'     => Alerts::FAMILY_CONSUMER_LAG,
			'deadletter:reader'       => Alerts::FAMILY_DEAD_LETTERS,
			'worker_down:job.p0'      => Alerts::FAMILY_WORKER_LIVENESS,
			'worker_missing:job.p0'   => Alerts::FAMILY_WORKER_LIVENESS,
		];
		foreach ( $rows as $key => $family ) {
			$results = $this->fleet_results_from_alerts(
				[ [ 'key' => $key, 'family' => $family, 'message' => "row {$key}", 'severity' => 'warning' ] ]
			);
			$landed = [];
			foreach ( $results as $result ) {
				if ( \in_array( "row {$key}", $result['messages'], true ) ) {
					$landed[] = $result['id'];
				}
			}
			$this->assertSame( [ $family ], $landed, "{$key} buckets on its declared family" );
		}
	}

	public function test_worst_status_orders_good_recommended_and_critical(): void {
		$good        = $this->good_cache_result();
		$recommended = \array_replace( $good, [ 'status' => Health_Checks::STATUS_RECOMMENDED ] );
		$critical    = \array_replace( $good, [ 'status' => Health_Checks::STATUS_CRITICAL ] );

		$this->assertSame( 'good', Health_Checks::worst_status( [ $good ] ) );
		$this->assertSame( 'recommended', Health_Checks::worst_status( [ $good, $recommended ] ) );
		$this->assertSame( 'critical', Health_Checks::worst_status( [ $recommended, $critical, $good ] ) );
	}

	public function test_worst_status_rejects_unknown_status(): void {
		$result           = $this->good_cache_result();
		$result['status'] = 'warning';

		$this->expectException( \UnexpectedValueException::class );
		$this->expectExceptionMessage( 'Unknown health status' );

		Health_Checks::worst_status( [ $result ] );
	}
}
