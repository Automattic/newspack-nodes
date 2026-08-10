<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * The two-ordering tier resolver: local_first (APCu → memcached) for
 * same-host hot surfaces, shared_first (memcached → APCu) for
 * cross-process sources of truth. Each picks ONE live backend — a claim
 * must never straddle tiers. Null = nothing available (callers keep
 * their fail-closed behavior).
 */
#[CoversClass( Cache_Backend::class )]
class CacheBackendTest extends TestCase {
	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
	}

	protected function tearDown(): void {
		Core::$memd                 = $this->prev_memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		if ( \property_exists( Cache_Backend::class, 'apcu_cache_info' ) ) {
			Cache_Backend::$apcu_cache_info = null;
		}
		if ( \property_exists( Cache_Backend::class, 'apcu_sma_info' ) ) {
			Cache_Backend::$apcu_sma_info = null;
		}
		parent::tearDown();
	}

	public function test_orderings_pick_one_live_backend(): void {
		$memd       = new InMemoryMemcached();
		Core::$memd = $memd;

		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$this->assertNotNull( Cache_Backend::local_first(), 'no APCu: local_first falls back to memcached' );
		Cache_Backend::local_first()->add( 'k1', 1, 60 );
		$this->assertSame( 1, $memd->get( 'k1' ), 'the fallback really is the memcached handle' );

		$this->assertNotNull( Cache_Backend::shared_first() );

		Core::$memd = null;
		$this->assertNull( Cache_Backend::local_first(), 'nothing available: null, callers fail closed' );
		$this->assertNull( Cache_Backend::shared_first() );
	}

	public function test_memcached_ops_round_trip(): void {
		Core::$memd                 = new InMemoryMemcached();
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$b                          = Cache_Backend::shared_first();

		$this->assertTrue( $b->add( 'claim', 1, 60 ) );
		$this->assertFalse( $b->add( 'claim', 1, 60 ), 'add is an atomic claim' );
		$this->assertTrue( $b->set( 'v', [ 'a' => 1 ], 60 ) );
		$this->assertSame( [ 'a' => 1 ], $b->get( 'v' ) );
		$this->assertTrue( $b->touch( 'v', 120 ) );
		$this->assertTrue( $b->delete( 'v' ) );
		$this->assertFalse( $b->get( 'v' ) );

		$b->set( 'n', 3, 60 );
		$this->assertSame( 4, $b->increment( 'n' ) );
		$this->assertSame( 3, $b->decrement( 'n' ) );
	}

	public function test_memcached_read_distinguishes_hit_confirmed_miss_and_backend_error(): void {
		$memd                       = new InMemoryMemcached();
		Core::$memd                 = $memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$backend                    = Cache_Backend::shared_first();

		$memd->set( 'read-hit', false, 83 );
		$hit = $this->read_with_status( $backend, 'read-hit' );
		$this->assertSame(
			[ 'status' => Cache_Backend::READ_HIT, 'value' => false ],
			$hit
		);
		$miss = $this->read_with_status( $backend, 'read-miss' );
		$this->assertSame(
			[ 'status' => Cache_Backend::READ_MISS, 'value' => null ],
			$miss
		);

		$memd->fail_get( 'read-error', \Memcached::RES_TIMEOUT );
		$error = $this->read_with_status( $backend, 'read-error' );
		$this->assertSame(
			[ 'status' => Cache_Backend::READ_ERROR, 'value' => null ],
			$error
		);
	}

	public function test_memcached_diagnostics_report_the_last_backend_read_error(): void {
		$memd = new class() extends InMemoryMemcached {
			public function getResultMessage(): string {
				return 'READ TIMED OUT 731';
			}
		};
		Core::$memd                 = $memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$backend                    = Cache_Backend::shared_first();
		$memd->fail_get( 'lease-pointer', \Memcached::RES_TIMEOUT );

		$backend->read( 'lease-pointer' );

		$this->assertTrue( \method_exists( Cache_Backend::class, 'backend_name' ), 'backend name diagnostic is missing' );
		$this->assertTrue( \method_exists( Cache_Backend::class, 'diagnostic_metadata' ), 'backend metadata diagnostic is missing' );
		$this->assertSame( 'memcached', $backend->backend_name() );
		$this->assertSame(
			[
				'memcached_result_code'    => \Memcached::RES_TIMEOUT,
				'memcached_result_message' => 'READ TIMED OUT 731',
			],
			$backend->diagnostic_metadata()
		);
	}

	public function test_apcu_diagnostics_report_safe_pressure_statistics(): void {
		$this->assertTrue( \property_exists( Cache_Backend::class, 'apcu_cache_info' ), 'APCu cache-info seam is missing' );
		$this->assertTrue( \property_exists( Cache_Backend::class, 'apcu_sma_info' ), 'APCu shared-memory seam is missing' );
		$this->assertTrue( \method_exists( Cache_Backend::class, 'backend_name' ), 'backend name diagnostic is missing' );
		$this->assertTrue( \method_exists( Cache_Backend::class, 'diagnostic_metadata' ), 'backend metadata diagnostic is missing' );
		Core::$memd                       = null;
		Cache_Backend::$apcu_usable       = static fn (): bool => true;
		Cache_Backend::$apcu_cache_info   = static fn ( bool $limited ): array => $limited
			? [ 'expunges' => 17 ]
			: [ 'expunges' => 999 ];
		Cache_Backend::$apcu_sma_info     = static fn ( bool $limited ): array => $limited
			? [ 'avail_mem' => 7654321 ]
			: [ 'avail_mem' => 999 ];
		$backend                          = Cache_Backend::shared_first();

		$this->assertSame( 'apcu', $backend->backend_name() );
		$this->assertSame(
			[
				'apcu_expunges'               => 17,
				'apcu_available_memory_bytes' => 7654321,
			],
			$backend->diagnostic_metadata()
		);
	}

	public function test_memcached_compare_and_swap_replaces_expected_integer_with_a_non_expiring_pointer(): void {
		$memd                       = new InMemoryMemcached();
		Core::$memd                 = $memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$backend                    = Cache_Backend::shared_first();

		$memd->set( 'lease-owner', 42424243, 83 );

		$this->assertTrue( $this->compare_and_swap_without_ttl( $backend, 'lease-owner', 42424243, 51515153 ) );
		$this->assertSame( 51515153, $memd->get( 'lease-owner' ) );
		$this->assertSame( 0, $memd->expiries()['lease-owner'] );
	}

	public function test_memcached_compare_and_swap_refuses_a_stale_expected_integer(): void {
		$memd                       = new InMemoryMemcached();
		Core::$memd                 = $memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$backend                    = Cache_Backend::shared_first();

		$memd->set( 'lease-owner', 51515153, 83 );

		$this->assertFalse( $this->compare_and_swap_without_ttl( $backend, 'lease-owner', 42424243, 60606061 ) );
		$this->assertSame( 51515153, $memd->get( 'lease-owner' ) );
	}

	public function test_memcached_compare_and_swap_never_sets_after_a_lost_cas_race(): void {
		$memd = new class() extends InMemoryMemcached {
			public int $set_calls = 0;

			public bool $reject_cas = false;

			public function set( string $key, mixed $value, int $expiration = 0 ): bool {
				++$this->set_calls;
				return parent::set( $key, $value, $expiration );
			}

			public function cas( string|int|float $cas_token, string $key, mixed $value, int $expiration = 0 ): bool {
				if ( $this->reject_cas ) {
					return false;
				}
				return parent::cas( $cas_token, $key, $value, $expiration );
			}
		};
		Core::$memd                 = $memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$backend                    = Cache_Backend::shared_first();

		$memd->set( 'lease-owner', 42424243, 83 );
		$set_calls_before = $memd->set_calls;
		$memd->reject_cas = true;

		$this->assertFalse( $this->compare_and_swap_without_ttl( $backend, 'lease-owner', 42424243, 51515153 ) );
		$this->assertSame( $set_calls_before, $memd->set_calls, 'a lost CAS race must not fall back to set()' );
		$this->assertSame( 42424243, $memd->get( 'lease-owner' ) );
	}

	public function test_memcached_read_multi_returns_found_keys_only(): void {
		$memd                       = new InMemoryMemcached();
		Core::$memd                 = $memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$backend                    = Cache_Backend::shared_first();

		$memd->set( 'sku-9', [ 'usd' => 1250 ], 0 );
		$memd->set( 'sku-7', 'plain', 0 );

		$this->assertSame(
			[ 'sku-9' => [ 'usd' => 1250 ], 'sku-7' => 'plain' ],
			$backend->read_multi( [ 'sku-9', 'sku-7', 'never-stored' ] )
		);
	}

	public function test_memcached_read_multi_reports_a_broken_batch_as_empty_and_says_so(): void {
		// getMulti answers false for the batch; there is no per-key status to
		// salvage, so a caller sees "nothing found" and falls through to its
		// slower tier. Empty reads as "nothing stored" downstream, so a broken
		// batch that said nothing would render a whole page as absent in
		// silence — this is the one place that knows the difference.
		$memd = new class() extends InMemoryMemcached {
			public function getMulti( array $keys, int $get_flags = 0 ): array|false {
				return false;
			}
		};
		Core::$memd                 = $memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$backend                    = Cache_Backend::shared_first();

		$memd->set( 'sku-9', 'stored', 0 );

		// Core::reset() in setUp restores the default handler for the next test.
		$captured = [];
		Core::set_stderr_handler(
			static function ( string $message ) use ( &$captured ): void {
				$captured[] = $message;
			}
		);

		$this->assertSame( [], $backend->read_multi( [ 'sku-9' ] ) );
		$this->assertNotEmpty(
			\array_filter( $captured, static fn ( string $l ): bool => \str_contains( $l, 'batch read error' ) ),
			'a failed batch must surface via print_less_often'
		);
	}

	public function test_read_multi_of_nothing_asks_the_backend_nothing(): void {
		$memd = new class() extends InMemoryMemcached {
			public int $multi_calls = 0;

			public function getMulti( array $keys, int $get_flags = 0 ): array|false {
				++$this->multi_calls;
				return parent::getMulti( $keys, $get_flags );
			}
		};
		Core::$memd                 = $memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$backend                    = Cache_Backend::shared_first();

		$this->assertSame( [], $backend->read_multi( [] ) );
		$this->assertSame( 0, $memd->multi_calls, 'an all-L1-hit lookup must not round-trip' );
	}

	// --- Real APCu arms (skip where the SAPI has no usable segment) ----------

	private function apcu_backend( string $order ): Cache_Backend {
		if ( ! \function_exists( 'apcu_enabled' ) || ! \apcu_enabled() ) {
			$this->markTestSkipped( 'APCu not usable in this SAPI (needs apc.enable_cli=1)' );
		}
		Cache_Backend::$apcu_usable = null; // real check
		Core::$memd                 = null; // force the APCu arm in both orderings
		$b                          = 'local' === $order ? Cache_Backend::local_first() : Cache_Backend::shared_first();
		$this->assertNotNull( $b );
		\apcu_delete( [ 'claim', 'v', 'n', 'owner' ] );
		return $b;
	}

	public function test_apcu_only_host_keeps_claim_surfaces_functional(): void {
		// The stock Atomic posture: APCu present, no memcached. Previously
		// fail-closed surfaces now work.
		if ( ! \function_exists( 'apcu_enabled' ) || ! \apcu_enabled() ) {
			$this->markTestSkipped( 'APCu not usable in this SAPI' );
		}
		Cache_Backend::$apcu_usable = null;
		Core::$memd                 = null;
		$tmp                        = $this->make_temp_dir( 'apcu-only-' );
		mkdir( "{$tmp}/locks", 0755, true );
		mkdir( "{$tmp}/logs", 0755, true );
		\apcu_delete( \Newspack_Nodes\Job_Intake::unique_key( 'apcu_h', 'solo' ) );

		$intake = new \Newspack_Nodes\Job_Intake( $tmp, 1 );
		try {
			$this->assertTrue( $intake->write_job( 'apcu_h', [], null, null, [ 'unique' => 'solo', 'unique_ttl' => 60 ] ) );
			$this->assertFalse( $intake->write_job( 'apcu_h', [], null, null, [ 'unique' => 'solo', 'unique_ttl' => 60 ] ), 'the dedup window holds on APCu alone' );
		} finally {
			$intake->close();
			$this->rmdir_recursive( $tmp );
		}
	}

	public function test_apcu_ops_round_trip(): void {
		$b = $this->apcu_backend( 'local' );

		$this->assertTrue( $b->add( 'claim', 1, 60 ) );
		$this->assertFalse( $b->add( 'claim', 1, 60 ), 'apcu_add is the same atomic claim' );
		$this->assertTrue( $b->set( 'v', [ 'a' => 1 ], 60 ) );
		$this->assertSame( [ 'a' => 1 ], $b->get( 'v' ) );
		$this->assertTrue( $b->touch( 'v', 120 ) );
		$this->assertTrue( $b->delete( 'v' ) );
		$this->assertFalse( $b->get( 'v' ) );

		$b->set( 'owner', 42424243, 0 );
		$this->assertTrue( $this->compare_and_swap_without_ttl( $b, 'owner', 42424243, 51515153 ) );
		$this->assertSame( 51515153, $b->get( 'owner' ) );
		$this->assertFalse( $this->compare_and_swap_without_ttl( $b, 'owner', 42424243, 60606061 ) );
	}

	public function test_apcu_read_multi_returns_found_keys_only(): void {
		$b = $this->apcu_backend( 'shared' );

		$b->set( 'v', [ 'a' => 1 ], 60 );
		$b->set( 'n', 7373, 60 );

		$this->assertSame(
			[ 'v' => [ 'a' => 1 ], 'n' => 7373 ],
			$b->read_multi( [ 'v', 'n', 'claim' ] )
		);
	}

	public function test_apcu_counters_clamp_at_zero_like_memcached(): void {
		$b = $this->apcu_backend( 'shared' );

		$b->set( 'n', 1, 60 );
		$this->assertSame( 2, $b->increment( 'n' ) );
		$this->assertSame( 1, $b->decrement( 'n' ) );
		$this->assertSame( 0, $b->decrement( 'n' ) );
		$this->assertSame( 0, $b->decrement( 'n' ), 'memcached clamps decrement at zero; the APCu arm must match' );
	}

	/**
	 * The ONE case where the two arms disagree, and the one the existing clamp
	 * test never reaches because it decrements a key it just set.
	 *
	 * `apcu_inc`/`apcu_dec` CREATE a missing key — that is what their `$ttl`
	 * parameter is for — while `Memcached::increment`/`decrement` return false
	 * and set RES_NOTFOUND. The clamp then turned `apcu_dec`'s phantom -1 into
	 * a stored 0, and `Job_Worker_Node::settle_batch()` reads 0 as "fan-in
	 * complete": an evicted batch counter fired `batch_complete` and a RESOLVED
	 * alert for work that never finished. Batch counters are seeded with a
	 * BATCH_TTL_S, so expiry is an expected state, not a corrupt one.
	 */
	public function test_apcu_counters_report_a_missing_key_as_false(): void {
		$b = $this->apcu_backend( 'shared' );

		$this->assertFalse(
			$b->decrement( 'nodes-job-batch:never-seeded-8842' ),
			'a missing counter must not decrement into a phantom zero'
		);
		$this->assertFalse(
			$b->get( 'nodes-job-batch:never-seeded-8842' ),
			'and must not be created as a side effect'
		);
		$this->assertFalse(
			$b->increment( 'nodes-job-batch-err:never-seeded-8842' ),
			'a missing counter must not increment into existence'
		);
		$this->assertFalse(
			$b->get( 'nodes-job-batch-err:never-seeded-8842' ),
			'and must not be created as a side effect'
		);
	}

	// ── key scoping ─────────────────────────────────────────────────────────

	/**
	 * Every shared surface routes through the scope, so a co-tenant install
	 * cannot read or clobber this one's state. Builders rather than raw
	 * prefixes because a scope a caller has to remember to apply is one a
	 * caller eventually forgets.
	 *
	 * @return array<string,array{0:string}>
	 */
	public static function scoped_key_provider(): array {
		return [
			'table entry'    => [ \Newspack_Nodes\Table_Node::entry_key( 'stats', '7719' ) ],
			'batch counter'  => [ \Newspack_Nodes\Job_Intake::batch_count_key( 'import-7719' ) ],
			'batch errors'   => [ \Newspack_Nodes\Job_Intake::batch_err_key( 'import-7719' ) ],
			'unique claim'   => [ \Newspack_Nodes\Job_Intake::unique_key( 'probe_h', 'tok-7719' ) ],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider( 'scoped_key_provider' )]
	public function test_shared_surfaces_are_site_scoped( string $key ): void {
		$this->assertStringStartsWith(
			'newspack_nodes:' . Cache_Backend::KEY_VERSION . ':' . Cache_Backend::site() . ':',
			$key
		);
		$this->assertStringNotContainsString( (string) \gethostname(), $key );
	}

	public function test_site_key_separates_co_tenant_installs_by_table_prefix(): void {
		// One memcached, one database, two installs told apart by their table
		// prefix — the dndocker second-docroot posture, and the Atomic one once
		// the database differs too.
		$prev = $GLOBALS['wpdb']->base_prefix;

		$GLOBALS['wpdb']->base_prefix = 'wp_';
		Cache_Backend::$site     = '';
		$alpha                   = Cache_Backend::site_key( 'table:stats:7719' );

		$GLOBALS['wpdb']->base_prefix = 'wpgyro_';
		Cache_Backend::$site     = '';
		$beta                    = Cache_Backend::site_key( 'table:stats:7719' );

		$GLOBALS['wpdb']->base_prefix = $prev;
		Cache_Backend::$site     = '';

		$this->assertNotSame( $alpha, $beta );
		$this->assertStringContainsString( Cache_Backend::KEY_VERSION, $alpha );
		$this->assertStringEndsWith( 'table:stats:7719', $alpha );
	}

	public function test_site_key_is_network_global_like_the_fleet_it_scopes(): void {
		// One fleet per NETWORK — Bootstrap::fleet_site() turns subsites away,
		// and locks/IPC/logs carry no blog namespace. Keying on the per-blog
		// prefix would split it: a subsite request seeds a batch counter the
		// main-site CLI worker then cannot find, so fan-in never completes.
		$prev = $GLOBALS['wpdb']->prefix;

		$GLOBALS['wpdb']->prefix = 'wp_';
		Cache_Backend::$site     = '';
		$main                    = Cache_Backend::site_key( 'job-batch:import-7719' );

		$GLOBALS['wpdb']->prefix = 'wp_2_';
		Cache_Backend::$site     = '';
		$subsite                 = Cache_Backend::site_key( 'job-batch:import-7719' );

		$GLOBALS['wpdb']->prefix = $prev;
		Cache_Backend::$site     = '';

		$this->assertSame( $main, $subsite );
	}

	public function test_site_key_does_not_move_with_the_request(): void {
		// home_url() forces https under is_ssl(), runs a filter, and moves under
		// switch_to_blog(). Keying on it split ONE install: a batch counter
		// seeded by a web request would be invisible to the CLI worker that
		// decrements it, and fan-in would never complete.
		$prev = $GLOBALS['_wp_test_home_url'] ?? null;

		$GLOBALS['_wp_test_home_url'] = 'http://example.test';
		Cache_Backend::$site          = '';
		$plain                        = Cache_Backend::site_key( 'job-batch:import-7719' );

		$GLOBALS['_wp_test_home_url'] = 'https://example.test';
		Cache_Backend::$site          = '';
		$secure                       = Cache_Backend::site_key( 'job-batch:import-7719' );

		$GLOBALS['_wp_test_home_url'] = $prev;
		Cache_Backend::$site          = '';

		$this->assertSame( $plain, $secure );
	}

	public function test_site_key_is_shared_across_containers_of_one_install(): void {
		// Table data, batch counters and unique claims are cross-container
		// sources of truth. Folding the hostname in would fragment them.
		$this->assertStringNotContainsString(
			(string) \gethostname(),
			Cache_Backend::site_key( 'job-batch:import-7719' )
		);
	}

	public function test_the_per_machine_budget_is_pinned_to_its_machine(): void {
		// SSE slots ration connections per pool host, so the machine IS the
		// resource — the one scope that must NOT be shared across containers.
		$namespace = \Newspack_Nodes\SSE_Slot_Pool::namespace_key();

		$this->assertStringContainsString( (string) \gethostname(), $namespace );
		$this->assertStringContainsString( Cache_Backend::site(), $namespace );
	}

	/**
	 * ONE grammar — `newspack_nodes:{version}:{scope}:{logical}` — so a reader
	 * holding a logical name can rebuild the key without knowing which surface
	 * wrote it. That is what `wp nodes memcache get <logical>` reverses; a
	 * surface that orders its parts differently is unreachable from the CLI.
	 */
	public function test_every_key_shares_one_grammar(): void {
		$prefix = 'newspack_nodes:' . Cache_Backend::KEY_VERSION . ':';

		$this->assertSame( $prefix . Cache_Backend::site() . ':table:x:1', Cache_Backend::site_key( 'table:x:1' ) );
		$this->assertSame(
			$prefix . Cache_Backend::machine() . ':' . Cache_Backend::site() . ':table:x:1',
			Cache_Backend::host_key( 'table:x:1' )
		);
		// The scopes differ only by the machine ahead of the site — never by
		// where the logical name sits.
		$this->assertSame(
			Cache_Backend::key( Cache_Backend::site(), 'table:x:1' ),
			Cache_Backend::site_key( 'table:x:1' )
		);
	}

	public function test_sse_slot_pool_reads_its_namespace_from_the_shared_scope(): void {
		// One owner for the host/site halves: the pool delegates rather than
		// keeping the second copy that drifted from everything else.
		$this->assertSame(
			Cache_Backend::machine() . ':' . Cache_Backend::site(),
			\Newspack_Nodes\SSE_Slot_Pool::namespace_key()
		);
	}

	private function compare_and_swap_without_ttl( Cache_Backend $backend, string $key, int $expected, int $replacement ): bool {
		$method = new \ReflectionMethod( Cache_Backend::class, 'compare_and_swap' );
		$this->assertSame( 3, $method->getNumberOfParameters(), 'pointer CAS must not carry or refresh a TTL' );
		return $backend->compare_and_swap( $key, $expected, $replacement );
	}

	/** @return array{status:string,value:mixed} */
	private function read_with_status( Cache_Backend $backend, string $key ): array {
		$this->assertTrue( \method_exists( Cache_Backend::class, 'read' ), 'cache read-status primitive is missing' );
		return $backend->read( $key );
	}
	public function test_rotating_the_salt_orphans_every_key_at_once(): void {
		// The ONE flush: the salt folds into the scope, so a rotation moves the
		// keyspace for every plugin on this install in a single step — no
		// per-plugin salt, and no co-tenant's keys touched.
		Cache_Backend::$site = '';
		$before              = Cache_Backend::site_key( 'table:prices:sku-9' );

		$rotated = Cache_Backend::rotate_salt();

		$this->assertNotSame( '', $rotated );
		$this->assertSame( $rotated, Cache_Backend::salt(), 'the rotation is readable back' );
		$this->assertNotSame( $before, Cache_Backend::site_key( 'table:prices:sku-9' ) );

		\delete_option( 'newspack_nodes_cache_salt' );
		Cache_Backend::$salt = null;
		Cache_Backend::$site = '';
		$this->assertSame( $before, Cache_Backend::site_key( 'table:prices:sku-9' ) );
	}
	public function test_the_salt_is_read_from_the_option_row_not_get_option(): void {
		// bin/pyrate runs under SHORTINIT, where get_option() is stubbed to
		// return the default — so a salt read that way is invisible to the CLI
		// while the web sees it, and the two write to split caches. Reading the
		// row through $wpdb is what keeps one rotation coherent across both.
		$GLOBALS['wpdb']->rows[ Cache_Backend::SALT_OPTION ] = 'row-7719';
		Cache_Backend::$salt = null;
		Cache_Backend::$site = '';

		$this->assertSame( 'row-7719', Cache_Backend::salt() );

		unset( $GLOBALS['wpdb']->rows[ Cache_Backend::SALT_OPTION ] );
		Cache_Backend::$salt = null;
		Cache_Backend::$site = '';

		$this->assertSame( '', Cache_Backend::salt(), 'no row means unflushed, not a salt' );
	}
}
