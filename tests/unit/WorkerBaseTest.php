<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Base;

#[CoversClass( Worker_Base::class )]
class WorkerBaseTest extends TestCase {
	private string $tmp;

	/** @var \Closure|null Bootstrap-installed curl seam, restored in tearDown so a test capturer can't leak. */
	private $saved_curl_exec;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp             = $this->make_temp_dir();
		$this->saved_curl_exec = Core::$curl_exec;
		// Deterministic shutdown classification: earlier tests' suppressed
		// warnings must not read as fatals through the real error_get_last().
		Worker_Base::$last_error = static fn (): ?array => null;
	}

	protected function tearDown(): void {
		Core::$curl_exec         = $this->saved_curl_exec;
		Worker_Base::$last_error = null;
		Worker_Base::$db_probe   = null;
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/**
	 * Capture self-respawn / spawn POSTs through the real Core::$curl_exec seam
	 * (the shared raw-curl path): URL off the handle, body as the 2nd seam arg.
	 *
	 * @param array<int,array{url:string,body:array<string,mixed>}> $posts Capture sink, by reference.
	 */
	private function capture_spawn_posts( array &$posts ): void {
		Core::$curl_exec = static function ( \CurlHandle $ch, array $body ) use ( &$posts ) {
			$posts[] = [
				'url'  => (string) \curl_getinfo( $ch, \CURLINFO_EFFECTIVE_URL ),
				'body' => $body,
			];
			return false;
		};
	}

	public function test_acquire_creates_worker_lock(): void {
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$this->assertTrue( $w->acquire() );
		$this->assertTrue( is_dir( "{$this->tmp}/locks/test-worker.p0.lock.d" ) );
	}

	public function test_acquire_fails_when_already_held(): void {
		$a = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$b = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$this->assertTrue( $a->acquire() );
		$this->assertFalse( $b->acquire() );
	}

	public function test_release_removes_lock(): void {
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$w->release();
		$this->assertFalse( is_dir( "{$this->tmp}/locks/test-worker.p0.lock.d" ) );
	}

	public function test_a_reload_signal_does_not_stop_the_worker(): void {
		// A reload says "re-read your config", never "exit" — the restart
		// channel is the only thing that retires a process.
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();

		$this->assertTrue(
			\Newspack_Nodes\Lock_Node::request_reload_at( "{$this->tmp}/locks/test-worker.p0.lock.d" )
		);

		$this->assertTrue( $w->should_continue() );
	}

	public function test_should_continue_returns_false_after_max_runtime(): void {
		$w = new TestableWorker( $this->tmp, 'test-worker', 0, max_runtime: 1 );
		$w->acquire();
		$w->set_start_time_for_test( microtime( true ) - 2.0 );
		$this->assertFalse( $w->should_continue() );
	}

	public function test_should_continue_does_not_log_normal_shutdown(): void {
		$w = new TestableWorker( $this->tmp, 'test-worker', 0, max_runtime: 1 );
		$w->acquire();
		$w->set_start_time_for_test( \microtime( true ) - 2.0 );
		$buf = '';
		\Newspack_Nodes\Core::set_stderr_handler(
			static function ( $m ) use ( &$buf ) {
				$buf .= $m;
			}
		);
		$this->assertFalse( $w->should_continue() );
		$this->assertSame( '', $buf );
	}

	public function test_should_continue_logs_memory_watermark_reason(): void {
		$w = new WatermarkWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$buf = '';
		\Newspack_Nodes\Core::set_stderr_handler(
			static function ( $m ) use ( &$buf ) {
				$buf .= $m;
			}
		);
		$this->assertFalse( $w->should_continue() );
		$this->assertStringContainsString( 'memory watermark', $buf );
	}

	public function test_should_continue_names_a_stolen_lock_rather_than_a_restart(): void {
		// A worker blocked in a long job goes stale and a peer steals the dir.
		// Reporting that as "restart requested" sends an operator looking for
		// the `wp nodes restart` nobody ran.
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$thief = \getmypid() + 4242;
		\file_put_contents( "{$this->tmp}/locks/test-worker.p0.lock.d/heartbeat", (string) $thief );
		$buf = '';
		\Newspack_Nodes\Core::set_stderr_handler(
			static function ( $m ) use ( &$buf ) {
				$buf .= $m;
			}
		);

		$this->assertFalse( $w->should_continue() );

		$this->assertStringContainsString( "lock stolen by pid {$thief}", $buf );
		$this->assertStringNotContainsString( 'restart requested', $buf );
	}

	public function test_should_continue_stamps_timeout_stop_reason(): void {
		// A max_runtime stop is categorized 'timeout' so the shutdown path applies the
		// cooperative-stop fair-shot rule (dead-letter [42]), not a blanket graceful handoff.
		$w = new TestableWorker( $this->tmp, 'test-worker', 0, max_runtime: 1 );
		$w->acquire();
		$w->set_start_time_for_test( \microtime( true ) - 2.0 );
		$this->assertFalse( $w->should_continue() );
		$this->assertSame( 'timeout', $this->read_private( $w, 'stop_reason' ) );
	}

	public function test_should_continue_stamps_memory_stop_reason(): void {
		$w = new WatermarkWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		\Newspack_Nodes\Core::set_stderr_handler( static function () { /* swallow */ } );
		$this->assertFalse( $w->should_continue() );
		$this->assertSame( 'memory', $this->read_private( $w, 'stop_reason' ) );
	}

	public function test_operational_stop_leaves_stop_reason_empty(): void {
		// Lock-lost / restart / db-fail are operational, NOT message poison — they must
		// NOT stamp a cooperative reason, so the shutdown hands off cleanly (no strike).
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$w->release(); // drop the lock so should_continue() takes the lock-lost branch.
		\Newspack_Nodes\Core::set_stderr_handler( static function () { /* swallow */ } );
		$this->assertFalse( $w->should_continue() );
		$this->assertSame( '', $this->read_private( $w, 'stop_reason' ) );
	}

	public function test_baseline_near_watermark_compares_baseline_to_the_limit(): void {
		// The memory baseline guard: a fresh post-reset baseline already at/above half the
		// limit is "near the watermark" (a leak / undersized limit), so a memory stop on it
		// must NOT strike the in-flight message.
		$w = new FixedLimitWorker( $this->tmp, 'test-worker', 0 );
		$ref = new \ReflectionClass( Worker_Base::class );
		$baseline = $ref->getProperty( 'baseline_memory' );
		$method   = new \ReflectionMethod( Worker_Base::class, 'baseline_near_watermark' );

		$baseline->setValue( $w, 600 ); // >= 1000 * 0.5
		$this->assertTrue( $method->invoke( $w ) );

		$baseline->setValue( $w, 100 ); // < 500
		$this->assertFalse( $method->invoke( $w ) );
	}

	public function test_is_fatal_shutdown_detects_unrecoverable_error_types(): void {
		// A catchable PHP fatal (OOM, E_ERROR) runs register_shutdown_function but bypasses
		// the cooperative finally. is_fatal_shutdown() tells the shutdown handler to treat it
		// as a crash (don't graceful-handoff) so the attempt counter climbs toward the crawl.
		$w   = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$ref = new \ReflectionMethod( Worker_Base::class, 'is_fatal_shutdown' );

		Worker_Base::$last_error = static fn (): ?array => null;
		$this->assertFalse( $ref->invoke( $w ), 'a clean exit (no error) is not fatal' );

		Worker_Base::$last_error = static fn (): ?array =>
			[ 'type' => \E_WARNING, 'message' => 'x', 'file' => 'f', 'line' => 1 ];
		$this->assertFalse( $ref->invoke( $w ), 'a non-fatal warning is not a fatal shutdown' );

		Worker_Base::$last_error = static fn (): ?array =>
			[ 'type' => \E_ERROR, 'message' => 'oom', 'file' => 'f', 'line' => 1 ];
		$this->assertTrue( $ref->invoke( $w ), 'E_ERROR (e.g. OOM) is a fatal shutdown' );
	}

	public function test_should_continue_returns_false_when_lock_lost(): void {
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$this->rmdir_recursive( "{$this->tmp}/locks/test-worker.p0.lock.d" );
		$this->assertFalse( $w->should_continue() );
	}

	public function test_should_continue_passes_when_db_check_succeeds(): void {
		$w = new DbCheckWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		// Force a db-check window by backdating last_db_check.
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		Worker_Base::$db_probe = static fn (): bool => true;
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 0, $w->get_db_failures_for_test() );
	}

	public function test_should_continue_returns_false_after_three_consecutive_db_failures(): void {
		$w = new DbCheckWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		Worker_Base::$db_probe = static fn (): bool => false;

		// 1st failure.
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 1, $w->get_db_failures_for_test() );

		// 2nd failure.
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 2, $w->get_db_failures_for_test() );

		// 3rd failure → trip.
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertFalse( $w->should_continue() );
		$this->assertSame( 3, $w->get_db_failures_for_test() );
	}

	public function test_should_continue_resets_db_failures_on_intermittent_pass(): void {
		$w = new DbCheckWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();

		// Failure.
		Worker_Base::$db_probe = static fn (): bool => false;
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 1, $w->get_db_failures_for_test() );

		// Pass — counter resets.
		Worker_Base::$db_probe = static fn (): bool => true;
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 0, $w->get_db_failures_for_test() );

		// Another failure — does NOT trip (counter started fresh).
		Worker_Base::$db_probe = static fn (): bool => false;
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 1, $w->get_db_failures_for_test() );
	}

	public function test_should_continue_skips_db_check_within_interval(): void {
		$w = new DbCheckWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		Worker_Base::$db_probe = static fn (): bool => false;
		// last_db_check is "now" from acquire(); db_check should not run.
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 0, $w->get_db_failures_for_test(), 'within interval: db_check must not run' );
	}

	public function test_should_continue_returns_false_when_restart_flag_set(): void {
		// External request_restart drops a `restart` file into the lock dir.
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		\file_put_contents( "{$this->tmp}/locks/test-worker.p0.lock.d/restart", (string) \time() );
		$this->assertFalse( $w->should_continue() );
	}

	public function test_should_continue_heartbeats_at_interval(): void {
		// heartbeat() bumps the lock-dir mtime — verify heartbeat fires when the
		// interval elapses.
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$hb_path = "{$this->tmp}/locks/test-worker.p0.lock.d/heartbeat";

		$first_mtime = \filemtime( $hb_path );
		// Backdate last_heartbeat past the heartbeat interval.
		$w->set_last_heartbeat_for_test( \microtime( true ) - Worker_Base::HEARTBEAT_INTERVAL_S - 1 );
		// Backdate the heartbeat file mtime so we can detect a refresh.
		\touch( $hb_path, \time() - 60 );

		$this->assertTrue( $w->should_continue() );
		\clearstatcache();
		$new_mtime = \filemtime( $hb_path );
		$this->assertGreaterThan( \time() - 5, $new_mtime, 'heartbeat must be touched recently' );
	}

	public function test_self_respawn_posts_to_spawn_url(): void {
		// self_respawn routes through the shared Core::fire_and_forget_post helper;
		// capture via the real curl seam so the body-assembly path is covered.
		$posts = [];
		$this->capture_spawn_posts( $posts );

		$w = new TestableWorker( $this->tmp, 'firehose-workers', 3 );
		$w->self_respawn( 'http://example.com/wp-json/newspack-nodes/v1/workers/spawn', 'token-123' );

		$this->assertCount( 1, $posts );
		$this->assertSame( 'http://example.com/wp-json/newspack-nodes/v1/workers/spawn', $posts[0]['url'] );
		// Worker type + partition + token are POSTed in the body so the spawn
		// endpoint can validate.
		$this->assertSame( 'firehose-workers', $posts[0]['body']['type'] );
		$this->assertSame( 3, $posts[0]['body']['partition'] );
		$this->assertSame( 'token-123', $posts[0]['body']['nonce'] );
	}

	public function test_memory_limit_bytes_parses_units(): void {
		// memory_limit_bytes parses M/G/K suffixes from ini_get('memory_limit').
		// We can't change ini at runtime in test, so exercise via reflection on
		// memory_get_usage path indirectly: check that the result is a sane
		// integer matching what ini_get reports.
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$ref = new \ReflectionMethod( Worker_Base::class, 'memory_limit_bytes' );

		$result = $ref->invoke( $w );
		// In test environment ini_get('memory_limit') is typically '128M' or '-1'.
		// Either way the function returns >= -1 and either matches the parsed value
		// or returns -1 explicitly.
		$ini = \ini_get( 'memory_limit' );
		if ( '-1' === $ini || false === $ini ) {
			$this->assertSame( -1, $result );
		} else {
			$this->assertGreaterThan( 0, $result );
		}
	}

	public function test_memory_over_watermark_returns_false_when_limit_unset(): void {
		// limit <= 0 → memory_over_watermark returns false (no shutdown trigger).
		// We can't easily force memory_limit=-1 inside a single test, but we can
		// directly verify the unlimited-memory path via subclass override.
		$w = new UnlimitedMemoryWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$ref = new \ReflectionMethod( Worker_Base::class, 'memory_over_watermark' );
		$this->assertFalse( $ref->invoke( $w ) );
	}

	public function test_db_probe_default_consults_wpdb_check_connection(): void {
		// The default probe is a REAL liveness check, not a permanently-true
		// stub: with a $wpdb present, its check_connection() verdict decides.
		global $wpdb;
		$prev = $wpdb ?? null;
		$wpdb = new class() {
			public int $calls = 0;
			public function check_connection( bool $allow_bail = true ): bool {
				++$this->calls;
				return false;
			}
		};
		Worker_Base::$db_probe = null; // exercise the real default closure.
		try {
			$w   = new TestableWorker( $this->tmp, 'test-worker', 0 );
			$ref = new \ReflectionMethod( Worker_Base::class, 'db_check_passes' );
			$this->assertFalse( $ref->invoke( $w ), 'a dead connection must fail the probe' );
			$this->assertSame( 1, $wpdb->calls, 'the probe must consult $wpdb->check_connection' );
		} finally {
			$wpdb = $prev;
		}
	}

	public function test_db_probe_default_passes_without_wpdb(): void {
		// Bare harness / pre-WP contexts have no $wpdb; the probe stays quiet.
		global $wpdb;
		$prev = $wpdb ?? null;
		$wpdb = null;
		Worker_Base::$db_probe = null;
		try {
			$w   = new TestableWorker( $this->tmp, 'test-worker', 0 );
			$ref = new \ReflectionMethod( Worker_Base::class, 'db_check_passes' );
			$this->assertTrue( $ref->invoke( $w ) );
		} finally {
			$wpdb = $prev;
		}
	}

	public function test_self_respawn_mints_a_fresh_token_via_the_provider(): void {
		// The token captured at boot is ~max_runtime stale at recycle time —
		// far outside the endpoint's 20s HMAC window, so reusing it 403s every
		// normal self-respawn. When the provider is wired, mint at POST time.
		$posts = [];
		$this->capture_spawn_posts( $posts );
		Worker_Base::$token_provider = static fn (): string => 'fresh-token-9f3';

		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->self_respawn( 'http://example/spawn', 'stale-boot-token' );

		$this->assertCount( 1, $posts );
		$this->assertSame( 'fresh-token-9f3', $posts[0]['body']['nonce'], 'self_respawn must not reuse the boot-time token' );
	}

	public function test_self_respawn_swallows_empty_url_without_posting(): void {
		// The shared helper rejects an empty URL ('empty url') before touching curl;
		// self_respawn logs it but must not throw or hit the seam.
		$posts = [];
		$this->capture_spawn_posts( $posts );
		\Newspack_Nodes\Core::set_stderr_handler( static function () { /* swallow */ } );

		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->self_respawn( '', 'token' );

		$this->assertCount( 0, $posts, 'an empty spawn URL never reaches the curl seam' );
	}

	public function test_execute_returns_skipped_when_lock_held_by_another(): void {
		// `execute()` first attempts to acquire(); if another process holds the
		// lock, it bails with status='skipped'. Simulate by acquiring the lock
		// from a sibling worker first.
		$held = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$this->assertTrue( $held->acquire(), 'baseline acquire must succeed' );

		$contender = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$result    = $contender->execute(
			fn() => null,           // never reached
			'http://example/',
			'token'
		);

		$this->assertSame( 'skipped', $result['status'] );
		$this->assertSame( 'lock_held', $result['reason'] );
	}

	public function test_execute_skip_reason_distinguishes_permission_failure_from_contention(): void {
		// Root-owned locks/ (the documented dndocker footgun): mkdir fails with
		// EACCES, which is NOT contention. The reason must say so instead of
		// the misdiagnosis chain reporting 'lock_held'.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'permission checks are moot as root' );
		}
		\mkdir( "{$this->tmp}/locks", 0555, true );
		\Newspack_Nodes\Core::set_stderr_handler( static function () { /* swallow */ } );
		$w = new TestableWorker( $this->tmp, 'test-worker', 7 );
		try {
			$result = $w->execute( fn() => null, 'http://example/', 'token' );
		} finally {
			\chmod( "{$this->tmp}/locks", 0755 );
		}

		$this->assertSame( 'skipped', $result['status'] );
		$this->assertStringContainsString( 'mkdir', $result['reason'], 'EACCES must not masquerade as contention' );
		$this->assertStringNotContainsString( 'lock_held', $result['reason'] );
	}

	public function test_execute_runs_topology_then_releases_lock_and_respawns(): void {
		// Happy path: topology closure sets the restart flag so should_continue()
		// returns false on the first drain tick; finally block releases the lock
		// and POSTs to the spawn endpoint (captured via the real curl seam).
		$posts = [];
		$this->capture_spawn_posts( $posts );

		$worker = new TestableWorker( $this->tmp, 'happy-path', 0 );

		$topology_lock_path = "{$this->tmp}/locks/happy-path.p0.lock.d";
		$topology = function ( $interpreter, $partition ) use ( $topology_lock_path ): void {
			// Drop the restart flag inside the topology closure so the first
			// drain iteration exits cleanly.
			\Newspack_Nodes\Lock_Node::request_restart_at( $topology_lock_path );
		};

		$result = $worker->execute( $topology, 'http://example/spawn', 'token-abc' );

		$this->assertSame( 'ok', $result['status'] );

		// Lock dir released — fleet / next spawn can take over.
		$this->assertFalse( \is_dir( $topology_lock_path ) );

		// Self-respawn POSTed to the spawn endpoint with the right body.
		$this->assertNotEmpty( $posts );
		$this->assertSame( 'http://example/spawn', $posts[0]['url'] );
		$this->assertSame( 'happy-path', $posts[0]['body']['type'] );
		$this->assertSame( 0, $posts[0]['body']['partition'] );
		$this->assertSame( 'token-abc', $posts[0]['body']['nonce'] );
	}

	public function test_execute_reports_a_topology_load_failure_cleanly_without_respawn(): void {
		// A malformed .tsl fails LOUD but CLEAN: one stderr line, lock released,
		// and NO self-respawn -- an immediate respawn would hot-loop on the same
		// bad file; the fleet retries on its own throttled tick.
		$posts = [];
		$this->capture_spawn_posts( $posts );

		$worker   = new TestableWorker( $this->tmp, 'bad-topo', 0 );
		$lock     = "{$this->tmp}/locks/bad-topo.p0.lock.d";
		$topology = static function (): void {
			throw new \RuntimeException( 'parse error: unterminated quote: cmd x add_profile Dont' );
		};

		$result = $worker->execute( $topology, 'http://example/spawn', 'tok' );

		$this->assertSame( 'load_failed', $result['status'] );
		$this->assertStringContainsString( 'unterminated quote', $result['error'] );
		$this->assertFalse( \is_dir( $lock ), 'lock released for the next attempt' );
		$this->assertSame( [], $posts, 'no self-respawn on a load failure' );
	}

	public function test_checkpoint_durable_consumers_checkpoints_remote_sources(): void {
		// Bug C: Remote_Source isn't a Consumer_Node, so the shutdown handoff must reach
		// it explicitly — otherwise its healthy cursor is lost on every ~10-min recycle.
		$w   = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$spy = new class() extends \Newspack_Nodes\Remote_Source_Node {
			public int $shutdown_calls = 0;
			public function checkpoint_shutdown(): void {
				++$this->shutdown_calls;
			}
		};
		$spy->name( 'remote-austin' );

		$w->checkpoint_durable_consumers();

		$this->assertSame( 1, $spy->shutdown_calls, 'the shutdown handoff must checkpoint Remote_Source nodes' );
	}

	public function test_cooperative_stop_routes_remote_source_to_the_fair_shot_rule(): void {
		// A cooperative stop (timeout/memory) must route Remote_Source through cooperative_stop
		// — the fair-shot rule, EXACTLY like a Consumer_Node — not the plain graceful shutdown.
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->set_stop_reason_for_test( 'timeout' );
		$spy = new class() extends \Newspack_Nodes\Remote_Source_Node {
			/** @var array<int,array{0:string,1:bool}> */
			public array $coop = [];
			public int $shutdown_calls = 0;
			public function cooperative_stop( string $reason, bool $baseline_near_watermark ): void {
				$this->coop[] = [ $reason, $baseline_near_watermark ];
			}
			public function checkpoint_shutdown(): void {
				++$this->shutdown_calls;
			}
		};
		$spy->name( 'remote-austin' );

		$w->checkpoint_durable_consumers();

		$this->assertSame( [ [ 'timeout', false ] ], $spy->coop, 'a cooperative stop routes Remote_Source to the fair-shot rule' );
		$this->assertSame( 0, $spy->shutdown_calls, 'and NOT the plain graceful shutdown' );
	}

	public function test_execute_checkpoints_ipc_input_at_shutdown(): void {
		// The clean-recycle shutdown path must checkpoint the IPC input so the
		// respawned worker resumes past consumed commands (no replay).
		$worker = new TestableWorker( $this->tmp, 'ckpt-exec', 0 );
		$lock   = "{$this->tmp}/locks/ckpt-exec.p0.lock.d";
		$topology = function ( $interpreter, $partition ) use ( $lock ): void {
			\Newspack_Nodes\Lock_Node::request_restart_at( $lock );
		};

		$worker->execute( $topology, 'http://example/spawn', 'tok' );

		$this->assertSame( 1, $worker->ipc_checkpoint_calls, 'execute shutdown must checkpoint the IPC input' );
	}

	public function test_ipc_partition_args_declare_all_five_retention_axes(): void {
		// An IPC partition is scratch plumbing: bounded by COUNT, never age-pruned.
		// Passing a bare count would land it on min_segments and inherit <config:*>
		// lifetimes — a min_lifetime of an hour means the scratch never prunes.
		$part = new \Newspack_Nodes\Partition_Node();
		$part->arguments( Worker_Base::ipc_partition_args( "{$this->tmp}/ipc" ) );

		$this->assertSame( 2, $this->read_private( $part, 'min_segments' ) );
		$this->assertSame( Worker_Base::IPC_NUM_SEGMENTS, $this->read_private( $part, 'num_segments' ), 'the retained count is the COUNT rule' );
		$this->assertSame( Worker_Base::IPC_MAX_SEGMENTS, $this->read_private( $part, 'max_segments' ), 'the hard cap is the unconditional ceiling' );
		$this->assertSame( 0, $this->read_private( $part, 'min_lifetime' ), 'no age floor: prune by count alone' );
		$this->assertSame( 0, $this->read_private( $part, 'lifetime' ), 'IPC never ages out on a timer' );
	}
}

class TestableWorker extends Worker_Base {
	public int $ipc_checkpoint_calls = 0;
	public function set_start_time_for_test( float $t ): void {
		$this->start_time = $t;
	}
	public function set_last_heartbeat_for_test( float $t ): void {
		$this->last_heartbeat = $t;
	}
	public function set_stop_reason_for_test( string $reason ): void {
		$this->stop_reason = $reason;
	}
	public function checkpoint_ipc_input(): void {
		++$this->ipc_checkpoint_calls;
		parent::checkpoint_ipc_input();
	}
}

class UnlimitedMemoryWorker extends Worker_Base {
	protected function memory_limit_bytes(): int {
		return -1;
	}
}

class WatermarkWorker extends Worker_Base {
	protected function memory_over_watermark(): bool {
		return true;
	}
}

class FixedLimitWorker extends Worker_Base {
	protected function memory_limit_bytes(): int {
		return 1000;
	}
}

class DbCheckWorker extends Worker_Base {
	public function set_last_db_check_for_test( float $t ): void {
		$this->last_db_check = $t;
	}

	public function get_db_failures_for_test(): int {
		return $this->db_failures;
	}
}
