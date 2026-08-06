<?php
/**
 * AlertsTest: the substrate Alerts evaluator.
 *
 * Alerts::evaluate() computes worker-down / consumer-lag / dlq-growth alerts
 * from the SAME snapshot Workers_CI builds. Alerts::emit() journals one
 * entry per alert into the alerts.p0 partition, rate-limited so a persisting
 * condition doesn't re-journal every sweep.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Alerts;
use Newspack_Nodes\Config;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Tests\TestCase;

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
		$this->tmp = (string) \realpath( \sys_get_temp_dir() ) . '/alerts-test-' . \uniqid();
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
		if ( ! \is_dir( $lock_dir ) ) {
			\mkdir( $lock_dir, 0755, true );
		}
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

		$this->assertArrayNotHasKey( 'deadletter:jobs.job-worker.p0', $by_key );
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

	public function test_deadletter_segments_yield_a_per_reader_warning(): void {
		$base = $this->arrange( [ 'live-workers' ] );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		$this->seed_deadletter( $base, 'jobs.job-worker.p0', 4 );

		$by_key = $this->alerts_by_key( Alerts::evaluate() );

		$this->assertArrayHasKey( 'deadletter:jobs.job-worker.p0', $by_key );
		$alert = $by_key['deadletter:jobs.job-worker.p0'];
		$this->assertSame( Alerts::SEVERITY_WARNING, $alert['severity'] );
		$this->assertSame( 4, $alert['count'] );
		$this->assertSame( 'jobs.job-worker.p0', $alert['reader'] );
		$this->assertStringContainsString( 'jobs.job-worker.p0', $alert['message'], 'the message names the owning queue' );
	}

	public function test_each_quarantined_reader_alerts_independently(): void {
		$base = $this->arrange( [ 'live-workers' ] );
		$this->seed_heartbeat( $base, 'live-workers', 0 );
		$this->seed_deadletter( $base, 'firehose.combined.p0', 1 );
		$this->seed_deadletter( $base, 'requests.combined.p0', 3 );

		$by_key = $this->alerts_by_key( Alerts::evaluate() );

		$this->assertArrayHasKey( 'deadletter:firehose.combined.p0', $by_key );
		$this->assertArrayHasKey( 'deadletter:requests.combined.p0', $by_key );
		$this->assertSame( 1, $by_key['deadletter:firehose.combined.p0']['count'] );
		$this->assertSame( 3, $by_key['deadletter:requests.combined.p0']['count'] );
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
		$this->assertArrayHasKey( 'deadletter:jobs.job-worker.p0', $by_key );
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

	public function test_a_persisting_alert_is_journaled_once_not_per_window(): void {
		$base = $this->arrange( [ 'stale-workers' ] );
		$this->seed_heartbeat( $base, 'stale-workers', 120 );

		Alerts::emit();
		$after_first = \count( $this->journal_messages( $base ) );
		// Next window opens (gate cleared); the condition persists unchanged.
		unset( $GLOBALS['_wp_test_transients']['newspack_nodes_alerts_emitted'] );
		Alerts::emit();

		$this->assertGreaterThan( 0, $after_first );
		$this->assertCount(
			$after_first,
			$this->journal_messages( $base ),
			'an unchanged condition journals nothing — the journal records transitions, not heartbeats'
		);
	}

	public function test_a_severity_change_journals_a_fresh_row(): void {
		$base = $this->arrange( [ 'flap-workers' ] );
		// Never-started worker: warning (worker_missing:flap-workers.p0).
		Alerts::emit();
		$first = \count( $this->journal_messages( $base ) );
		$this->assertGreaterThan( 0, $first );

		// The worker heartbeats once, then goes stale: worker_down (critical).
		// Different KEY = a new alert raising; the old key resolves.
		$this->seed_heartbeat( $base, 'flap-workers', 120 );
		unset( $GLOBALS['_wp_test_transients']['newspack_nodes_alerts_emitted'] );
		Alerts::emit();

		$messages = $this->journal_messages( $base );
		$keys     = \array_map( static fn ( $m ) => $m[ Message::KEY ], $messages );
		$this->assertContains( 'worker_down:flap-workers.p0', $keys );
	}

	public function test_a_resolved_alert_journals_a_resolution_row(): void {
		$base = $this->arrange( [ 'heal-workers' ] );
		$this->seed_heartbeat( $base, 'heal-workers', 120 ); // stale → critical.
		Alerts::emit();

		// The worker recovers: fresh heartbeat, condition gone.
		$this->seed_heartbeat( $base, 'heal-workers', 0 );
		unset( $GLOBALS['_wp_test_transients']['newspack_nodes_alerts_emitted'] );
		Alerts::emit();

		$messages = $this->journal_messages( $base );
		$resolved = \array_values( \array_filter(
			$messages,
			static fn ( $m ) => 'resolved' === ( (array) $m[ Message::VALUE ] )['severity']
		) );
		$this->assertCount( 1, $resolved );
		$this->assertSame( 'worker_down:heal-workers.p0', $resolved[0][ Message::KEY ] );
		$this->assertStringContainsString( 'resolved', ( (array) $resolved[0][ Message::VALUE ] )['m'] );

		// Fully healthy + already reconciled: another window journals nothing.
		unset( $GLOBALS['_wp_test_transients']['newspack_nodes_alerts_emitted'] );
		$count = \count( $this->journal_messages( $base ) );
		Alerts::emit();
		$this->assertCount( $count, $this->journal_messages( $base ) );
	}

	public function test_a_gated_transition_is_journaled_when_the_window_opens(): void {
		// The gate may swallow a tick, but the state option only advances on a
		// real write — so the transition lands on the next open window.
		$base = $this->arrange( [ 'late-workers' ] );
		$this->seed_heartbeat( $base, 'late-workers', 0 );
		Alerts::emit(); // healthy: nothing to journal, but the gate arms.
		$this->seed_heartbeat( $base, 'late-workers', 120 );
		Alerts::emit(); // gated: swallowed.
		$this->assertCount( 0, $this->journal_messages( $base ) );

		unset( $GLOBALS['_wp_test_transients']['newspack_nodes_alerts_emitted'] );
		Alerts::emit();
		$keys = \array_map( static fn ( $m ) => $m[ Message::KEY ], $this->journal_messages( $base ) );
		$this->assertContains( 'worker_down:late-workers.p0', $keys );
	}

	public function test_emit_survives_a_throwing_journal_write(): void {
		$base = $this->arrange( [ 'stale-workers' ] );
		$this->seed_heartbeat( $base, 'stale-workers', 120 );

		$throwing_journal = new class() extends \Newspack_Nodes\Partition_Node {
			public function fill( array $message ): void {
				throw new \RuntimeException( 'boom-777' );
			}
		};
		$property = new \ReflectionProperty( Alerts::class, 'journal' );
		$property->setValue( null, $throwing_journal );

		Alerts::emit();

		$this->assertTrue( true, 'emit() must not let a journal-write throw escape' );
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

	public function test_journal_event_writes_one_row_with_the_errors_family_shape(): void {
		$base = $this->arrange( [] );

		Alerts::journal_event( 'batch:b7', 'batch b7 complete (3 jobs)', Alerts::SEVERITY_RESOLVED );

		$messages = $this->journal_messages( $base );
		$this->assertCount( 1, $messages );
		$this->assertSame( 'batch:b7', $messages[0][ Message::KEY ] );
		$value = $messages[0][ Message::VALUE ];
		$this->assertSame( 1, $value['n'] );
		$this->assertSame( 'alert', $value['k'] );
		$this->assertSame( 'batch b7 complete (3 jobs)', $value['m'] );
		$this->assertSame( Alerts::SEVERITY_RESOLVED, $value['severity'] );
		$this->assertIsFloat( $value['ts'] );
	}
}
