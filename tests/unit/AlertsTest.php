<?php
/**
 * AlertsTest: the substrate Alerts evaluator.
 *
 * Alerts::evaluate() computes worker-down / consumer-lag / dlq-growth alerts
 * from the SAME snapshot Workers_CI builds. Alerts::emit() journals one
 * entry per alert into the alerts.p0 partition, rate-limited so a persisting
 * condition doesn't re-journal every supervisor tick.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Alerts;
use Newspack_Nodes\Config;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Alerts::class )]
class AlertsTest extends TestCase {

	private ?string $tmp = null;

	protected function setUp(): void {
		parent::setUp();
		Alerts::reset();
		\Newspack_Nodes\Topology_Registry::reset();
		$GLOBALS['_wp_options']          = [];
		$GLOBALS['_wp_actions']          = [];
		$GLOBALS['_wp_test_transients']  = [];
	}

	protected function tearDown(): void {
		Alerts::reset();
		\Newspack_Nodes\Topology_Registry::reset();
		$GLOBALS['_wp_options']          = [];
		$GLOBALS['_wp_actions']          = [];
		$GLOBALS['_wp_test_transients']  = [];
		if ( null !== $this->tmp ) {
			$this->rmdir_recursive( $this->tmp );
			$this->tmp = null;
		}
		parent::tearDown();
	}

	/**
	 * Register a fleet of topologies (each one partition) + activate them so
	 * Workers_CI::collect_dump_metadata enumerates them.
	 *
	 * @param array<int,string>   $types         Topology names.
	 * @param array<string,mixed> $config_extras Extra config overlaid onto the local test config.
	 * @return string Base dir.
	 */
	private function arrange( array $types, array $config_extras = [] ): string {
		$this->tmp = '/tmp/alerts-test-' . \uniqid();
		\mkdir( $this->tmp, 0755, true );
		$this->use_base_dir( $this->tmp, \array_merge( [ 'num_partitions' => 1 ], $config_extras ) );
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ) use ( $types ): array {
				foreach ( $types as $name ) {
					$topologies[ $name ] = [ 'topology' => $name, 'num_partitions' => 1, 'stale_timeout' => 60 ];
				}
				return $topologies;
			}
		);
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = $types;
		Config::reset();
		return $this->tmp;
	}

	private function seed_heartbeat( string $base, string $type, int $age_seconds ): void {
		$lock_dir = "{$base}/locks/{$type}.p0.lock.d";
		\mkdir( $lock_dir, 0755, true );
		\touch( "{$lock_dir}/heartbeat", \time() - $age_seconds );
	}

	private function seed_supervisor_heartbeat( string $base, int $age_seconds ): void {
		$lock_dir = "{$base}/locks/supervisor.lock.d";
		\mkdir( $lock_dir, 0755, true );
		\touch( "{$lock_dir}/heartbeat", \time() - $age_seconds );
	}

	private function seed_probe_distance( string $base, string $source_basename, int $distance ): void {
		$dir = "{$base}/logs/topicprobe.p0";
		\mkdir( $dir, 0755, true );
		$record                                 = [];
		$record[ Probe_Record::SOURCE ]         = "{$source_basename}.p0";
		$record[ Probe_Record::READER ]         = "{$source_basename}.p0";
		$record[ Probe_Record::CURSOR_SEGMENT ] = 0;
		$record[ Probe_Record::CURSOR_OFF ]     = 0;
		$record[ Probe_Record::END_SEGMENT ]    = 0;
		$record[ Probe_Record::END_SIZE ]       = 0;
		$record[ Probe_Record::DISTANCE ]       = $distance;
		$record[ Probe_Record::MSGS ]           = 0;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $record;
		\file_put_contents( "{$dir}/0.log", Message::packed( $message ) . "\n", FILE_APPEND );
	}

	private function seed_deadletter( string $base, string $reader, int $segments ): void {
		$dir = "{$base}/deadletter/{$reader}";
		\mkdir( $dir, 0755, true );
		for ( $i = 0; $i < $segments; $i++ ) {
			\file_put_contents( "{$dir}/{$i}.log", 'x' );
		}
	}

	/** @return array<int,array<string,mixed>> */
	private function alerts_by_key( array $alerts ): array {
		$out = [];
		foreach ( $alerts as $alert ) {
			$out[ $alert['key'] ] = $alert;
		}
		return $out;
	}

	/** @return array<int,array<int,mixed>> Unpacked alerts.p0 journal messages, write order. */
	private function journal_messages( string $base ): array {
		$out   = [];
		$files = \glob( "{$base}/logs/alerts.p0/*.log" );
		\sort( $files );
		foreach ( $files as $file ) {
			foreach ( \file( $file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES ) as $line ) {
				$out[] = Message::unpacked( $line );
			}
		}
		return $out;
	}

	public function test_stale_worker_yields_a_critical_alert(): void {
		$base = $this->arrange( [ 'stale-workers' ] );
		$this->seed_heartbeat( $base, 'stale-workers', 120 ); // > 60s stale timeout.

		$by_key = $this->alerts_by_key( Alerts::evaluate() );

		$this->assertArrayHasKey( 'worker_down:stale-workers.p0', $by_key );
		$this->assertSame( Alerts::SEVERITY_CRITICAL, $by_key['worker_down:stale-workers.p0']['severity'] );
	}

	public function test_never_started_worker_yields_a_warning_alert(): void {
		$base = $this->arrange( [ 'missing-workers' ] );
		// No heartbeat file at all → never-seen dead worker.

		$by_key = $this->alerts_by_key( Alerts::evaluate() );

		$this->assertArrayHasKey( 'worker_missing:missing-workers.p0', $by_key );
		$this->assertSame( Alerts::SEVERITY_WARNING, $by_key['worker_missing:missing-workers.p0']['severity'] );
	}

	public function test_running_worker_yields_no_alert(): void {
		$base = $this->arrange( [ 'live-workers' ] );
		$this->seed_heartbeat( $base, 'live-workers', 0 );

		$this->assertSame( [], Alerts::evaluate() );
	}

	public function test_supervisor_stale_yields_a_critical_alert(): void {
		$base = $this->arrange( [ 'live-workers' ] );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		$this->seed_supervisor_heartbeat( $base, 300 );

		$by_key = $this->alerts_by_key( Alerts::evaluate() );

		$this->assertArrayHasKey( 'supervisor_down', $by_key );
		$this->assertSame( Alerts::SEVERITY_CRITICAL, $by_key['supervisor_down']['severity'] );
	}

	public function test_consumer_over_distance_threshold_yields_a_warning(): void {
		$base = $this->arrange( [ 'live-workers' ] );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		// Distinct from every default; well over the 64 MiB threshold.
		$this->seed_probe_distance( $base, 'firehose', 99_000_000 );

		$by_key = $this->alerts_by_key( Alerts::evaluate() );

		$this->assertArrayHasKey( 'consumer_lag:firehose.p0', $by_key );
		$this->assertSame( Alerts::SEVERITY_WARNING, $by_key['consumer_lag:firehose.p0']['severity'] );
		$this->assertSame( 99_000_000, $by_key['consumer_lag:firehose.p0']['distance'] );
	}

	public function test_consumer_under_threshold_yields_no_lag_alert(): void {
		$base = $this->arrange( [ 'live-workers' ] );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		$this->seed_probe_distance( $base, 'firehose', 1024 );

		$this->assertSame( [], Alerts::evaluate() );
	}

	public function test_evaluate_honors_configured_lag_threshold(): void {
		// Configured threshold well below the 64 MiB constant default.
		$base = $this->arrange( [ 'live-workers' ], [ 'alert_lag_threshold' => 12345678 ] );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		// Above the configured 12345678, but below the old 67108864 constant.
		$this->seed_probe_distance( $base, 'firehose', 12345679 );

		$by_key = $this->alerts_by_key( Alerts::evaluate() );

		$this->assertArrayHasKey( 'consumer_lag:firehose.p0', $by_key );
		$this->assertSame( 12345679, $by_key['consumer_lag:firehose.p0']['distance'] );
	}

	public function test_evaluate_honors_configured_deadletter_threshold(): void {
		// Raise the DLQ threshold above zero so a small quarantine stays quiet.
		$base = $this->arrange( [ 'live-workers' ], [ 'alert_deadletter_threshold' => 5 ] );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		// 3 <= 5 configured, but 3 > 0 default — the constant would alert.
		$this->seed_deadletter( $base, 'jobs.job-worker.p0', 3 );

		$by_key = $this->alerts_by_key( Alerts::evaluate() );

		$this->assertArrayNotHasKey( 'deadletter', $by_key );
	}

	public function test_emit_honors_configured_emit_interval(): void {
		// 777s window, distinct from the 300s constant default.
		$this->arrange( [ 'live-workers' ], [ 'alert_emit_interval' => 777 ] );

		$before = \time();
		Alerts::emit();

		$stored = $GLOBALS['_wp_test_transients']['newspack_nodes_alerts_emitted'] ?? null;
		$this->assertNotNull( $stored, 'emit must set the rate-limit transient' );
		[ , $expires_at ] = $stored;
		$this->assertGreaterThanOrEqual( $before + 777, $expires_at );
		$this->assertLessThanOrEqual( $before + 779, $expires_at );
	}

	public function test_deadletter_segments_yield_a_warning(): void {
		$base = $this->arrange( [ 'live-workers' ] );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		$this->seed_deadletter( $base, 'jobs.job-worker.p0', 4 );

		$by_key = $this->alerts_by_key( Alerts::evaluate() );

		$this->assertArrayHasKey( 'deadletter', $by_key );
		$this->assertSame( Alerts::SEVERITY_WARNING, $by_key['deadletter']['severity'] );
		$this->assertSame( 4, $by_key['deadletter']['count'] );
	}

	public function test_worst_severity_prefers_critical(): void {
		$alerts = [
			[ 'key' => 'a', 'severity' => Alerts::SEVERITY_WARNING ],
			[ 'key' => 'b', 'severity' => Alerts::SEVERITY_CRITICAL ],
		];
		$this->assertSame( Alerts::SEVERITY_CRITICAL, Alerts::worst_severity( $alerts ) );
		$this->assertSame( '', Alerts::worst_severity( [] ) );
	}

	public function test_emit_journals_one_entry_per_alert_to_alerts_p0(): void {
		$base = $this->arrange( [ 'stale-workers' ] );
		$this->seed_heartbeat( $base, 'stale-workers', 120 );
		$this->seed_deadletter( $base, 'jobs.job-worker.p0', 2 );

		Alerts::emit();

		$messages = $this->journal_messages( $base );
		$by_key   = [];
		foreach ( $messages as $message ) {
			$by_key[ $message[ Message::KEY ] ] = $message;
		}
		$this->assertArrayHasKey( 'worker_down:stale-workers.p0', $by_key );
		$this->assertArrayHasKey( 'deadletter', $by_key );
	}

	public function test_emit_journal_entry_shape_matches_the_errors_family_plus_severity(): void {
		$base = $this->arrange( [ 'stale-workers' ] );
		$this->seed_heartbeat( $base, 'stale-workers', 120 );

		Alerts::emit();

		$messages = $this->journal_messages( $base );
		$this->assertNotEmpty( $messages );
		$message = $messages[0];
		$this->assertSame( Message::TM_STRUCT, $message[ Message::TYPE ] );
		$this->assertSame( 'alerts', $message[ Message::FROM ] );
		$entry = (array) $message[ Message::VALUE ];
		$this->assertSame( 1, $entry['n'] );
		$this->assertSame( 'alert', $entry['k'] );
		$this->assertSame( Alerts::SEVERITY_CRITICAL, $entry['severity'] );
		$this->assertStringContainsString( 'stale-workers.p0', $entry['m'] );
		$this->assertIsFloat( $entry['ts'] );
	}

	public function test_emit_is_rate_limited_within_the_window(): void {
		$base = $this->arrange( [ 'stale-workers' ] );
		$this->seed_heartbeat( $base, 'stale-workers', 120 );

		Alerts::emit();
		$after_first = \count( $this->journal_messages( $base ) );
		Alerts::emit(); // second call within the window is gated.

		$this->assertGreaterThan( 0, $after_first );
		$this->assertCount( $after_first, $this->journal_messages( $base ) );
	}

	public function test_emit_fires_no_wp_action(): void {
		$base = $this->arrange( [ 'stale-workers' ] );
		$this->seed_heartbeat( $base, 'stale-workers', 120 );

		$fired = 0;
		\add_action( 'newspack_nodes/alert', static function () use ( &$fired ): void {
			++$fired;
		} );

		Alerts::emit();

		$this->assertSame( 0, $fired, 'the alert action was deleted; journaling replaced it' );
		$this->assertNotEmpty( $this->journal_messages( $base ) );
	}
}
