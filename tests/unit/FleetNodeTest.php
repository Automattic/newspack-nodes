<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Fleet_Node;
use Newspack_Nodes\Internal_Request_Token;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Fleet_Node::class )]
class FleetNodeTest extends TestCase {
	/** The fleet's base dir: locks live here, and it is what mount_fleet passes. */
	private string $tmp;

	/** A DIFFERENT dir installed as the ambient config base, so `$args[0]` is provably load-bearing. */
	private string $decoy;

	/** The bootstrap's capture seam, restored in tearDown by the one test that replaces it. */
	private ?\Closure $saved_curl_exec = null;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp                       = $this->make_temp_dir();
		$this->decoy                     = $this->make_temp_dir( 'fleet-decoy-' );
		$GLOBALS['_test_outbound_posts'] = [];
		$this->saved_curl_exec           = Core::$curl_exec;
		// The spawn throttle persists; TestCase resets options but not transients.
		$GLOBALS['_wp_test_transients']  = [];
		// Force the throttle onto the transient tier, which we DO clear per test;
		// a shared handle would leak spawn records between tests.
		Core::$memd = null;
		// Ambient base_dir deliberately != the fleet's: a Fleet that ignored its
		// argument would scan the decoy, find no locks, and spawn the world.
		$this->use_base_dir( $this->decoy );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'ledger-workers' ];
		Config::reset();
		Bootstrap::$fleet_enabled_override = null;
		( new Router_Node() )->name( Node_Names::ROUTER );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		$this->rmdir_recursive( $this->decoy );
		Core::$curl_exec = $this->saved_curl_exec;
		// A failed assertion skips a test's inline cleanup; the stock-dir
		// registration must not outlive the test that made it either way.
		Topology_Registry::reset();
		$GLOBALS['_test_outbound_posts'] = [];
		$GLOBALS['_wp_test_transients']  = [];
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		Bootstrap::$fleet_enabled_override = null;
		Config::reset();
		parent::tearDown();
	}

	private function with_topology( array $topologies ): void {
		\add_filter( 'newspack_nodes/topologies', static fn() => $topologies );
	}

	/** Three partitions, so the partition loop is exercised past expand_workers' default of 1. */
	private function ledger( int $partitions = 3 ): array {
		return [ 'ledger-workers' => [ 'num_partitions' => $partitions, 'topology' => '/ledger.php' ] ];
	}

	private function mount_fleet(): Fleet_Node {
		$fleet = new Fleet_Node();
		$fleet->name( Node_Names::FLEET );
		$fleet->sink( Core::node( Node_Names::ROUTER ) );
		$fleet->arguments( [ $this->tmp, $this->own_lock_dir() ] );
		return $fleet;
	}

	/** The lock dir this worker holds — where its own reload watermark lands. */
	private function own_lock_dir(): string {
		return "{$this->tmp}/locks/ledger-workers.p0.lock.d";
	}

	/** Touch the reload watermark with an explicit mtime, so no test leans on wall-clock. */
	private function signal_reload( int $mtime ): void {
		$flag = $this->own_lock_dir() . '/' . \Newspack_Nodes\Lock_Node::RELOAD_FLAG;
		\file_put_contents( $flag, (string) $mtime );
		\touch( $flag, $mtime );
		\clearstatcache( true, $flag );
	}

	/** @return list<mixed> RELOAD payloads the fleet notified, in order. */
	private function capture_reloads( Fleet_Node $fleet, array &$seen ): void {
		$fleet->register( 'RELOAD', 'reload-spy', static function ( $payload ) use ( &$seen ): bool {
			$seen[] = $payload;
			return true;
		} );
	}

	/** @return list<array<string,mixed>> The `body` of each captured spawn POST. */
	private function posted_bodies(): array {
		return \array_column( \array_column( $GLOBALS['_test_outbound_posts'] ?? [], 'args' ), 'body' );
	}

	/** The scan cadence in seconds — what a test must advance past to get a second pass. */
	private function scan_interval_s(): float {
		return Fleet_Node::SCAN_INTERVAL_MS / 1000;
	}

	private function make_lock( string $name, bool $alive = true ): void {
		\mkdir( "{$this->tmp}/locks/{$name}.lock.d", 0755, true );
		if ( $alive ) {
			\touch( "{$this->tmp}/locks/{$name}.lock.d/heartbeat" );
		}
	}

	// ── the scan cadence ───────────────────────────────────────────────────

	public function test_the_scan_arms_a_fifteen_second_router_timer(): void {
		// Revival off a stale heartbeat is dominated by stale_timeout (60s), so
		// scanning every router tick buys ~1s on the crash path alone and costs
		// 15x the glob/stat passes per worker, times every worker.
		$fleet = $this->mount_fleet();

		$this->assertSame( 15000, Fleet_Node::SCAN_INTERVAL_MS );
		$this->assertSame( Fleet_Node::SCAN_INTERVAL_MS, $fleet->interval_ms );
		$this->assertSame( 'router', $fleet->timer_mode(), 'the scan hitchhikes the router heartbeat' );
	}

	public function test_a_router_tick_inside_the_scan_interval_does_not_rescan(): void {
		// Twelve partitions down against a four-per-pass cap: a second pass two
		// seconds later would post four MORE. Only the timer holds it at four.
		$this->with_topology( [ 'ledger-workers' => [ 'num_partitions' => 12, 'topology' => '/ledger.php' ] ] );
		$fleet = $this->mount_fleet();
		$start = 1893456123.0;

		Core::$now = $start;
		$fleet->fire_cb();
		$this->assertCount( Fleet_Node::MAX_SPAWNS_PER_TICK, $this->posted_bodies() );

		Core::$now = $start + 2.0;
		$fleet->fire_cb();
		$this->assertCount(
			Fleet_Node::MAX_SPAWNS_PER_TICK,
			$this->posted_bodies(),
			'a router tick inside the scan interval must not rescan'
		);

		Core::$now = $start + ( Fleet_Node::SCAN_INTERVAL_MS / 1000 ) + 1.0;
		$fleet->fire_cb();
		$this->assertCount(
			Fleet_Node::MAX_SPAWNS_PER_TICK * 2,
			$this->posted_bodies(),
			'the next window resumes the scan'
		);
	}

	// ── the peer-spawn scan ────────────────────────────────────────────────

	public function test_fire_spawns_a_worker_whose_lock_dir_is_missing(): void {
		$this->with_topology( $this->ledger() );
		// p0 and p2 alive; only p1 is down.
		$this->make_lock( 'ledger-workers.p0' );
		$this->make_lock( 'ledger-workers.p2' );

		Core::right_now();
		$this->mount_fleet()->fire_cb();

		$bodies = $this->posted_bodies();
		$this->assertCount( 1, $bodies, 'only the down partition is spawned' );
		$this->assertSame( 'ledger-workers', $bodies[0]['type'] );
		$this->assertSame( 1, $bodies[0]['partition'] );
	}

	public function test_the_spawn_token_validates_against_the_site_salt(): void {
		// The key must NOT be a node argument (it would be dumped in cleartext);
		// the node mints from Spawn_Coordinator::spawn_key() itself.
		$this->with_topology( $this->ledger( 1 ) );

		$now = (int) Core::right_now();
		$this->mount_fleet()->fire_cb();

		$bodies = $this->posted_bodies();
		$this->assertCount( 1, $bodies );
		$this->assertTrue(
			Internal_Request_Token::validate(
				Internal_Request_Token::PURPOSE_SPAWN,
				$bodies[0]['nonce'],
				$now,
				\Newspack_Nodes\Spawn_Coordinator::spawn_key()
			),
			'the endpoint validates against the derived spawn key; the token must match'
		);
	}

	public function test_fire_skips_a_worker_a_peer_already_spawned(): void {
		$this->with_topology( $this->ledger( 1 ) );
		// Seeded through the SHARED throttle store, not this node's memory —
		// cross-process dedup is what makes N scanners safe.
		$now = Core::right_now();
		( new \Newspack_Nodes\Spawn_Coordinator( $this->tmp ) )->record_spawn( 'ledger-workers', 0, $now );

		$this->mount_fleet()->fire_cb();

		$this->assertSame( [], $this->posted_bodies(), 'inside the throttle window a peer scan must not re-POST' );
	}

	public function test_caps_the_spawn_posts_it_issues_in_one_tick(): void {
		// Each POST is a BLOCKING curl (250ms). Unbounded, a cold fleet would
		// spend the whole tick in syscalls instead of draining messages.
		$this->with_topology( [
			'ledger-workers' => [ 'num_partitions' => 12, 'topology' => '/ledger.php' ],
		] );

		Core::right_now();
		$this->mount_fleet()->fire_cb();

		$this->assertLessThanOrEqual(
			Fleet_Node::MAX_SPAWNS_PER_TICK,
			\count( $this->posted_bodies() ),
			'a tick must not block the drain loop on an unbounded POST run'
		);
	}

	// ── resilience ─────────────────────────────────────────────────────────

	public function test_a_throwing_topology_provider_does_not_kill_the_worker(): void {
		// expand_workers runs third-party filter callbacks. An escape here
		// unwinds through the router into Worker_Base, which catches only
		// Worker_Should_Stop — every worker would crash-loop on the same tick.
		\add_filter( 'newspack_nodes/topologies', static function (): array {
			throw new \RuntimeException( 'a topology provider exploded' );
		} );

		Core::right_now();
		$fleet = $this->mount_fleet();

		$fleet->fire_cb();

		$this->assertSame( [], $this->posted_bodies() );
	}

	public function test_a_failed_spawn_post_is_reported(): void {
		$this->with_topology( $this->ledger( 1 ) );
		// The error Fleet reports is curl_error(), not a seam return value, so a
		// canned response proves nothing — only a real errno reaches the branch.
		Core::$curl_exec = static function ( \CurlHandle $ch, array $body ) {
			\curl_setopt( $ch, \CURLOPT_URL, 'no-route-to-host://nowhere' );
			return \curl_exec( $ch );
		};
		$seen = [];
		Core::set_stderr_handler( static function ( string $line ) use ( &$seen ): void {
			$seen[] = $line;
		} );

		Core::right_now();
		$this->mount_fleet()->fire_cb();

		$this->assertNotEmpty(
			\array_filter(
				$seen,
				static fn( $l ) => \str_contains( $l, 'spawn failed for ledger-workers.p0: ' )
					&& \str_contains( $l, 'no-route-to-host' )
			),
			'a fleet that cannot post spawns must not fail silently'
		);
	}

	// ── config ─────────────────────────────────────────────────────────────

	public function test_refuses_to_spawn_a_write_conflicting_set(): void {
		// Two topologies writing one partition log with DIFFERENT geometry. The
		// fleet refuses that set; a second spawner that does not would keep
		// the conflict alive. Byte-identical declarations would instead be the
		// sanctioned multi-writer share (topic-probe), and no conflict at all.
		$stock = $this->make_temp_dir( 'fleet-conflict-stock-' );
		\file_put_contents( "{$stock}/alpha.tsl", "var num_partitions = 2\nmake_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1048576 2 4 0 0\n" );
		\file_put_contents( "{$stock}/beta.tsl", "var num_partitions = 2\nmake_node Partition audit:partition <config:logs_dir>/requests.p<partition> 4194304 8 16 0 0\n" );
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha', 'beta' ];
		Config::reset();

		Core::right_now();
		$this->mount_fleet()->fire_cb();

		$this->assertSame( [], $this->posted_bodies(), 'a conflicting set must not be spawned' );
		$this->rmdir_recursive( $stock );
	}

	public function test_defers_the_first_spawn_of_a_newly_activated_type(): void {
		$this->with_topology( \array_merge( $this->ledger( 1 ), [
			'audit-workers' => [ 'num_partitions' => 1, 'topology' => '/audit.php' ],
		] ) );
		$this->make_lock( 'ledger-workers.p0' );

		$fleet = $this->mount_fleet();
		$start = Core::right_now();
		$fleet->fire_cb();
		$this->assertSame( [], $this->posted_bodies(), 'only ledger is active, and it is alive' );

		// Operator activates audit-workers; its predecessor may still be flushing.
		// The settings save fans a reload watermark out with the write — that
		// signal is what makes the cached active set stale.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'ledger-workers', 'audit-workers' ];
		$this->signal_reload( 1730000731 );
		Core::$now = $start + $this->scan_interval_s() + 1;
		$fleet->fire_cb();
		$this->assertSame( [], $this->posted_bodies(), 'a newly-seen type waits for its predecessor to flush' );

		// A whole scan interval later: past both the timer and the spawn delay.
		Core::$now = $start + ( 2 * $this->scan_interval_s() ) + 2;
		$fleet->fire_cb();
		$this->assertSame( [ 'audit-workers' ], \array_column( $this->posted_bodies(), 'type' ) );
	}

	public function test_a_first_config_check_never_drains_the_fleet(): void {
		// A transient empty read on the very first check must not be mistaken
		// for a deactivation — that would retire every worker at once.
		$this->with_topology( [] );
		$this->make_lock( 'ledger-workers.p0' );

		Core::right_now();
		$this->mount_fleet()->fire_cb();

		$this->assertFileDoesNotExist( "{$this->tmp}/locks/ledger-workers.p0.lock.d/restart" );
	}

	public function test_deactivating_every_topology_flags_running_workers_for_restart(): void {
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$this->make_lock( 'audit-workers.p3' );

		$fleet = $this->mount_fleet();
		$start = Core::right_now();
		$fleet->fire_cb();
		$this->assertFileDoesNotExist( "{$this->tmp}/locks/ledger-workers.p0.lock.d/restart", 'a live fleet is left alone' );

		// Operator deactivates everything: running workers must retire. The
		// write's reload watermark is what makes the cached set stale.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [];
		$this->signal_reload( 1730000731 );
		Core::$now = $start + $this->scan_interval_s() + 1;
		$fleet->fire_cb();

		$this->assertFileExists( "{$this->tmp}/locks/ledger-workers.p0.lock.d/restart" );
		$this->assertFileExists( "{$this->tmp}/locks/audit-workers.p3.lock.d/restart" );
	}

	// ── the reload watermark ───────────────────────────────────────────────

	public function test_a_reload_watermark_notifies_reload(): void {
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet = $this->mount_fleet();
		$seen  = [];
		$this->capture_reloads( $fleet, $seen );

		// Deliberately not "now": a version reading the clock instead of the
		// file's mtime would still pass with a wall-clock seed.
		$this->signal_reload( 1730000731 );
		Core::right_now();
		$fleet->fire_cb();

		$this->assertSame( [ '1730000731' ], $seen );
	}

	public function test_the_notification_carries_a_non_empty_string_value(): void {
		// notify()'s payload defaults to NULL, and TM_INFO VALUEs are strings;
		// a bare notify( 'RELOAD' ) would put null on a subscriber's message.
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet     = $this->mount_fleet();
		$listener  = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$listener->name( 'reload-listener-8264' );
		$fleet->register( 'RELOAD', 'reload-listener-8264' );

		$this->signal_reload( 1730000731 );
		Core::right_now();
		$fleet->fire_cb();

		$this->assertCount( 1, $listener->captured );
		$message = $listener->captured[0];
		$this->assertIsString( $message[ \Newspack_Nodes\Message::VALUE ] );
		$this->assertSame( '1730000731', $message[ \Newspack_Nodes\Message::VALUE ] );
		$this->assertSame( Node_Names::FLEET, $message[ \Newspack_Nodes\Message::FROM ] );
		$this->assertSame( \Newspack_Nodes\Message::TM_INFO, $message[ \Newspack_Nodes\Message::TYPE ] );
		$this->assertSame( 'RELOAD', $message[ \Newspack_Nodes\Message::KEY ] );
	}

	public function test_an_unchanged_watermark_does_not_notify_again(): void {
		// The whole win: without a signal there is no shared-cache purge, so
		// `alloptions` stays cacheable site-wide between vault changes.
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet = $this->mount_fleet();
		$seen  = [];
		$this->capture_reloads( $fleet, $seen );

		$this->signal_reload( 1730000731 );
		$start = Core::right_now();
		$fleet->fire_cb();

		Core::$now = $start + $this->scan_interval_s() + 1;
		$fleet->fire_cb();

		$this->assertSame( [ '1730000731' ], $seen, 'the same watermark must be acted on once' );
	}

	public function test_a_second_touch_in_the_same_worker_lifetime_is_noticed(): void {
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet = $this->mount_fleet();
		$seen  = [];
		$this->capture_reloads( $fleet, $seen );

		$this->signal_reload( 1730000731 );
		$start = Core::right_now();
		$fleet->fire_cb();

		// Distinct from the first watermark AND from any wall-clock default.
		$this->signal_reload( 1730004297 );
		Core::$now = $start + $this->scan_interval_s() + 1;
		$fleet->fire_cb();

		$this->assertSame( [ '1730000731', '1730004297' ], $seen );
	}

	/**
	 * A reload must drop EVERY memo keyed off the active set, not the two of the
	 * four Topology_Registry::invalidate_config_cache() names. A worker lives
	 * ~595s, so a probe that keeps its old cadence and a stale on-demand reader
	 * map outlive the settings save by ten minutes.
	 */
	public function test_a_reload_drops_every_memo_keyed_off_the_active_set(): void {
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet = $this->mount_fleet();

		$wake_ref = new \ReflectionProperty( Bootstrap::class, 'on_demand_wake_map' );
		$wake_ref->setValue( null, [ '/marmot/stale-partition' => [] ] );
		$probe_ref = new \ReflectionProperty( \Newspack_Nodes\Topic_Probe_Node::class, 'declared_interval_s' );
		$probe_ref->setValue( null, 8264 );

		$this->signal_reload( 1730000731 );
		Core::right_now();
		$fleet->fire_cb();

		$this->assertNull( $wake_ref->getValue(), 'the on-demand reader map is keyed off the active set' );
		$this->assertNull( $probe_ref->getValue(), 'so is the probe cadence, read out of topic-probe.tsl' );
	}

	public function test_a_reload_subscriber_reads_the_new_config_synchronously(): void {
		// Notify-before-reset leaves Config holding boot values at delivery, so
		// a subscriber that reads inline gets the value the reload exists to
		// replace. Today's only subscriber defers its read a tick and hides it.
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet = $this->mount_fleet();
		\update_option( 'newspack_nodes_lifetime', 41 );
		$this->assertSame( 41, \Newspack_Nodes\Config::value( 'lifetime' ) );

		\update_option( 'newspack_nodes_lifetime', 8135 );
		$read = null;
		$fleet->register( 'RELOAD', 'config-reader-8135', static function () use ( &$read ): bool {
			$read = \Newspack_Nodes\Config::value( 'lifetime' );
			return true;
		} );
		$this->signal_reload( 1730000731 );
		Core::right_now();
		$fleet->fire_cb();

		$this->assertSame( 8135, $read, 'RELOAD must be notified after the config reset, never before' );
	}

	public function test_two_requests_inside_the_same_second_are_both_delivered(): void {
		// A settings save writes several options in one request, so two reload
		// requests inside one second is the ordinary case, not the exotic one.
		// At 1s mtime resolution the second is LOST, not merely late.
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet = $this->mount_fleet();
		$seen  = [];
		$this->capture_reloads( $fleet, $seen );
		$flag = $this->own_lock_dir() . '/' . \Newspack_Nodes\Lock_Node::RELOAD_FLAG;

		\Newspack_Nodes\Lock_Node::request_reload_at( $this->own_lock_dir() );
		\touch( $flag, 1730000731 );
		$start = Core::right_now();
		$fleet->fire_cb();

		\Newspack_Nodes\Lock_Node::request_reload_at( $this->own_lock_dir() );
		\touch( $flag, 1730000731 );
		Core::$now = $start + $this->scan_interval_s() + 1;
		$fleet->fire_cb();

		$this->assertCount( 2, $seen, 'a second request inside one second is late at worst, never lost' );
		$this->assertNotSame( $seen[0], $seen[1], 'each request mints its own watermark' );
	}

	public function test_the_watermark_is_consumed_by_comparison_not_by_unlinking(): void {
		// Unlink-after-consume loses a touch that lands mid-reload and cannot
		// survive a lock steal; the file must still be there afterwards.
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet = $this->mount_fleet();
		$this->signal_reload( 1730000731 );

		Core::right_now();
		$fleet->fire_cb();

		$this->assertFileExists( $this->own_lock_dir() . '/' . \Newspack_Nodes\Lock_Node::RELOAD_FLAG );
	}

	public function test_a_pass_with_no_watermark_never_resets_config(): void {
		// Config::reset() fires RESET_ACTION, whose subscribers drop the parsed-TSL
		// cache — so an unconditional reset re-globs both topology dirs and
		// re-parses every .tsl every window to reach the value it already had.
		// The watermark is what makes the cache stale; without one there is
		// nothing to re-read.
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet = $this->mount_fleet();
		\update_option( 'newspack_nodes_lifetime', 8135 );
		$this->assertSame( 8135, Config::value( 'lifetime' ), 'seed the cache with a value no default shares' );

		$resets = 0;
		\add_action( Config::RESET_ACTION, static function () use ( &$resets ): void {
			++$resets;
		} );
		// A write nothing signalled: the cached fleet is current by definition.
		\update_option( 'newspack_nodes_lifetime', 44021 );

		Core::right_now();
		$fleet->fire_cb();

		$this->assertSame( 0, $resets, 'no watermark, no reset, no TSL re-parse' );
		$this->assertSame( 8135, Config::value( 'lifetime' ), 'the cache must survive an unsignalled pass' );
	}

	public function test_a_watermark_resets_config_so_the_pass_reads_the_new_value(): void {
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet = $this->mount_fleet();
		\update_option( 'newspack_nodes_lifetime', 8135 );
		$this->assertSame( 8135, Config::value( 'lifetime' ) );

		$resets = 0;
		\add_action( Config::RESET_ACTION, static function () use ( &$resets ): void {
			++$resets;
		} );
		\update_option( 'newspack_nodes_lifetime', 44021 );
		$this->signal_reload( 1730004297 );

		Core::right_now();
		$fleet->fire_cb();

		$this->assertSame( 1, $resets, 'a signalled pass resets exactly once' );
		$this->assertSame( 44021, Config::value( 'lifetime' ) );
	}

	public function test_a_missing_watermark_never_notifies(): void {
		$this->with_topology( $this->ledger( 1 ) );
		$this->make_lock( 'ledger-workers.p0' );
		$fleet = $this->mount_fleet();
		$seen  = [];
		$this->capture_reloads( $fleet, $seen );

		Core::right_now();
		$fleet->fire_cb();

		$this->assertSame( [], $seen );
	}

	// ── schema ─────────────────────────────────────────────────────────────

	public function test_a_missing_base_dir_refuses_at_the_boundary(): void {
		$fleet = new Fleet_Node();
		$fleet->name( Node_Names::FLEET );

		$this->expectException( \InvalidArgumentException::class );
		$fleet->arguments( [] );
	}

	public function test_the_scan_enqueues_no_job_of_its_own(): void {
		// The scan is revival and nothing else: housekeeping moved to the cron
		// pass, so a fleet with no claim store, no job pool and no memcached
		// still revives. Revival may never depend on housekeeping.
		Core::$memd = null;
		\Newspack_Nodes\Cache_Backend::$apcu_usable = static fn (): bool => false;
		$this->with_topology( $this->ledger( 1 ) );

		Core::right_now();
		$this->mount_fleet()->fire_cb();

		$this->assertCount( 1, $this->posted_bodies(), 'a claim store outage must not stop the peer scan' );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- test scratch.
		$this->assertSame( [], \glob( "{$this->tmp}/logs/jobintake.p0/*" ) ?: [], 'the scan writes no job' );
		\Newspack_Nodes\Cache_Backend::$apcu_usable = null;
	}

	public function test_node_schema_documents_its_own_arguments(): void {
		// Inherited unchanged, `help Fleet` would describe Timer's interval_ms.
		$schema = Fleet_Node::node_schema();

		$this->assertSame( [ 'base_dir', 'lock_dir' ], \array_column( $schema['arguments'], 'name' ) );
		$this->assertSame( 'Hidden', $schema['category'], 'scaffolding mounts it; it is not a palette node' );
		$this->assertContains( 'RELOAD', $schema['registrations'], 'nodes subscribe to RELOAD to re-read captured config' );
	}
}
