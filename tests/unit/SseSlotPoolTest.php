<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\SSE_Slot_Pool;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Substrate SSE slot pool: the slot algorithm + SSE_Out seam wiring,
 * using configured Memcached first and APCu as the fallback.
 *
 * The pool owns the atomic add/CAS lease claim. Tests set `Core::$memd` to an
 * in-memory `\Memcached` subclass so the algorithm runs deterministically.
 */
#[CoversClass( SSE_Slot_Pool::class )]
class SseSlotPoolTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		SSE_Out_Node::$acquire_slot = null;
		SSE_Out_Node::$release_slot = null;
		SSE_Out_Node::$check_slot   = null;
		if ( \property_exists( SSE_Out_Node::class, 'inspect_slot' ) ) {
			SSE_Out_Node::$inspect_slot = null;
		}
		SSE_Slot_Pool::$max_slots   = 10;
		SSE_Slot_Pool::$ttl         = 60;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		Core::$memd                 = new InMemoryMemcached();
	}

	protected function tearDown(): void {
		SSE_Out_Node::$acquire_slot = null;
		SSE_Out_Node::$release_slot = null;
		SSE_Out_Node::$check_slot   = null;
		if ( \property_exists( SSE_Out_Node::class, 'inspect_slot' ) ) {
			SSE_Out_Node::$inspect_slot = null;
		}
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		Core::$memd                 = null;
		parent::tearDown();
	}

	/**
	 * The slot must outlive the client's session-forget threshold, or the moment
	 * a client starts re-authenticating is the moment its slot lapses — and the
	 * keepalive is gated on having a session, so it cannot refresh during re-auth.
	 * Read off the DECLARED default; setUp's fixture value must not mask it.
	 */
	public function test_default_ttl_outlives_the_client_session_forget_threshold(): void {
		$declared = ( new \ReflectionClass( SSE_Slot_Pool::class ) )->getDefaultProperties()['ttl'];
		$forget   = \Newspack_Nodes\Remote_Link_Node::HEARTBEAT_INTERVAL * 3;

		$this->assertGreaterThan(
			$forget,
			$declared,
			'slot TTL must leave room for a re-auth round trip'
		);
	}

	/**
	 * A valid owner touch refreshes only liveness. The slot pointer is bounded
	 * by the configured slot count, so it remains non-expiring identity
	 * metadata and cannot need an unsafe conditional TTL refresh.
	 */
	public function test_matching_owner_touch_keeps_pointer_permanent_and_applies_ttl_to_liveness(): void {
		$lease = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 4, 83 );
		$this->assertIsArray( $lease );
		$before = \time();

		$this->assertTrue( SSE_Slot_Pool::touch( 'lease-host', 17, 'abc12345', $lease['slot'], $lease['owner'], 47 ) );

		$pointer_key = 'newspack_nodes:sse:v2:lease-host:17:abc12345:0';
		$lease_key   = "{$pointer_key}:lease:{$lease['owner']}";
		$expiries    = Core::$memd->expiries();
		$this->assertCount( 2, $expiries );
		$this->assertSame( 0, $expiries[ $pointer_key ] );
		$this->assertGreaterThanOrEqual( $before + 47, $expiries[ $lease_key ] );
		$this->assertLessThanOrEqual( \time() + 47, $expiries[ $lease_key ] );
	}

	public function test_configured_memcached_is_preferred_even_when_apcu_is_usable(): void {
		/** @var InMemoryMemcached $memd */
		$memd                       = Core::$memd;
		Cache_Backend::$apcu_usable = static fn (): bool => true;
		$pointer_key                = 'newspack_nodes:sse:v2:shared-host:73:fedcba98:0';
		$lease                      = false;

		try {
			$lease = SSE_Slot_Pool::acquire( 'shared-host', 73, 'fedcba98', 3, 47 );

			$this->assertIsArray( $lease );
			$this->assertSame( 0, $lease['slot'] );
			$this->assertSame(
				[
					$pointer_key,
					"{$pointer_key}:lease:{$lease['owner']}",
				],
				$memd->keys(),
				'configured Memcached must own SSE leases even when APCu is usable'
			);
		} finally {
			if ( \function_exists( 'apcu_delete' ) ) {
				\apcu_delete( $pointer_key );
				if ( \is_array( $lease ) ) {
					\apcu_delete( "{$pointer_key}:lease:{$lease['owner']}" );
				}
			}
		}
	}

	// ── slot algorithm (direct) ──────────────────────────────────────────────

	public function test_acquire_returns_a_complete_positive_owner_lease(): void {
		$lease = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 8, 47 );

		$this->assertIsArray( $lease );
		$this->assertSame( [ 'slot', 'owner' ], \array_keys( $lease ) );
		$this->assertSame( 0, $lease['slot'] );
		$this->assertIsInt( $lease['owner'] );
		$this->assertGreaterThan( 0, $lease['owner'] );
	}

	public function test_acquire_returns_first_free_slot(): void {
		$first  = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 8, 47 );
		$second = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 8, 47 );

		$this->assertIsArray( $first );
		$this->assertIsArray( $second );
		$this->assertSame( 0, $first['slot'] );
		$this->assertSame( 1, $second['slot'] );
	}

	public function test_acquire_returns_false_when_pool_exhausted(): void {
		$first  = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 2, 47 );
		$second = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 2, 47 );

		$this->assertIsArray( $first );
		$this->assertIsArray( $second );
		$this->assertSame( 0, $first['slot'] );
		$this->assertSame( 1, $second['slot'] );
		$this->assertFalse( SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 2, 47 ) );
	}

	public function test_slot_keys_use_the_coordinated_v2_substrate_prefix(): void {
		// The pool is substrate infrastructure; its keys must live in the
		// newspack_nodes namespace, not a consumer application's.
		$lease = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 1, 47 );
		$this->assertIsArray( $lease );
		/** @var InMemoryMemcached $memd */
		$memd = Core::$memd;
		$pointer_key = 'newspack_nodes:sse:v2:lease-host:17:abc12345:0';
		$this->assertSame(
			[
				$pointer_key,
				"{$pointer_key}:lease:{$lease['owner']}",
			],
			$memd->keys()
		);
	}

	public function test_slots_are_namespaced_per_hostname(): void {
		// Same user + ip on two hosts get independent pools (shared memcache).
		$host_a = SSE_Slot_Pool::acquire( 'hostA', 17, 'abc12345', 1, 47 );
		$host_b = SSE_Slot_Pool::acquire( 'hostB', 17, 'abc12345', 1, 47 );

		$this->assertIsArray( $host_a );
		$this->assertIsArray( $host_b );
		$this->assertSame( 0, $host_a['slot'] );
		$this->assertFalse( SSE_Slot_Pool::acquire( 'hostA', 17, 'abc12345', 1, 47 ) );
		$this->assertSame( 0, $host_b['slot'] );
	}

	public function test_hostname_is_always_a_non_empty_string(): void {
		// The `?: 'unknown'` fallback guarantees a gethostname() failure can never
		// pass false to the string-typed slot methods.
		$host = SSE_Slot_Pool::namespace_key();
		$this->assertIsString( $host );
		$this->assertNotSame( '', $host );
	}

	public function test_releasing_current_owner_makes_the_slot_immediately_reclaimable(): void {
		$first = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 8, 47 );
		$this->assertIsArray( $first );
		$this->assertSame( 0, $first['slot'] );
		$pointer_key = 'newspack_nodes:sse:v2:lease-host:17:abc12345:0';
		$lease_key   = "{$pointer_key}:lease:{$first['owner']}";

		$this->assertTrue( SSE_Slot_Pool::release( 'lease-host', 17, 'abc12345', $first['slot'], $first['owner'] ) );
		$this->assertSame( 0, Core::$memd->get( $pointer_key ), 'release must publish the reserved tombstone before deleting liveness' );
		$this->assertFalse( Core::$memd->get( $lease_key ) );
		$replacement = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 8, 47 );

		$this->assertIsArray( $replacement );
		$this->assertSame( 0, $replacement['slot'] );
		$this->assertNotSame( $first['owner'], $replacement['owner'] );
		$this->assertTrue( SSE_Slot_Pool::check( 'lease-host', 17, 'abc12345', $replacement['slot'], $replacement['owner'] ) );
	}

	public function test_release_tombstones_pointer_before_deleting_liveness(): void {
		$memd = new class() extends InMemoryMemcached {
			public string $pointer_key = '';

			public string $lease_key = '';

			public mixed $pointer_at_delete = null;

			public function delete( string $key, int $time = 0 ): bool {
				if ( $this->lease_key === $key ) {
					$this->pointer_at_delete = parent::get( $this->pointer_key );
				}
				return parent::delete( $key, $time );
			}
		};
		Core::$memd        = $memd;
		$owner             = 42424243;
		$memd->pointer_key = 'newspack_nodes:sse:v2:order-host:73:fedcba98:0';
		$memd->lease_key   = "{$memd->pointer_key}:lease:{$owner}";
		$memd->set( $memd->pointer_key, $owner, 0 );
		$memd->set( $memd->lease_key, 1, 83 );

		$this->assertTrue( SSE_Slot_Pool::release( 'order-host', 73, 'fedcba98', 0, $owner ) );
		$this->assertSame( 0, $memd->pointer_at_delete );
	}

	public function test_check_requires_the_matching_owner(): void {
		$lease       = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 8, 47 );
		$this->assertIsArray( $lease );
		$wrong_owner = 42424243 === $lease['owner'] ? 51515153 : 42424243;

		$this->assertTrue( SSE_Slot_Pool::check( 'lease-host', 17, 'abc12345', $lease['slot'], $lease['owner'] ) );
		$this->assertFalse( SSE_Slot_Pool::check( 'lease-host', 17, 'abc12345', $lease['slot'], $wrong_owner ) );
		$this->assertFalse( SSE_Slot_Pool::check( 'lease-host', 17, 'abc12345', 5, $lease['owner'] ) );
	}

	public function test_touch_requires_the_matching_owner(): void {
		$lease       = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 8, 83 );
		$this->assertIsArray( $lease );
		$wrong_owner = 42424243 === $lease['owner'] ? 51515153 : 42424243;

		$this->assertTrue( SSE_Slot_Pool::touch( 'lease-host', 17, 'abc12345', $lease['slot'], $lease['owner'], 47 ) );
		$this->assertFalse( SSE_Slot_Pool::touch( 'lease-host', 17, 'abc12345', $lease['slot'], $wrong_owner, 47 ) );
		$this->assertFalse( SSE_Slot_Pool::touch( 'lease-host', 17, 'abc12345', 5, $lease['owner'], 47 ) );
	}

	public function test_dead_owner_pointer_is_reclaimed_by_compare_and_swap(): void {
		$pointer_key = 'newspack_nodes:sse:v2:lease-host:17:abc12345:0';
		$dead_owner  = 42424243;
		Core::$memd->set( $pointer_key, $dead_owner, 0 );

		$this->assertFalse( SSE_Slot_Pool::check( 'lease-host', 17, 'abc12345', 0, $dead_owner ) );
		$this->assertFalse( SSE_Slot_Pool::touch( 'lease-host', 17, 'abc12345', 0, $dead_owner, 79 ) );
		$this->assertSame( $dead_owner, Core::$memd->get( $pointer_key ) );

		$lease = SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 1, 47 );

		$this->assertIsArray( $lease );
		$this->assertSame( 0, $lease['slot'] );
		$this->assertNotSame( $dead_owner, $lease['owner'] );
		$this->assertSame( $lease['owner'], Core::$memd->get( $pointer_key ) );
		$this->assertTrue( SSE_Slot_Pool::check( 'lease-host', 17, 'abc12345', $lease['slot'], $lease['owner'] ) );
	}

	public function test_acquire_stages_liveness_before_publishing_the_pointer(): void {
		$memd = new class() extends InMemoryMemcached {
			public string $pointer_key = '';

			/** @var list<string> */
			public array $keys_before_pointer_publication = [];

			/** @var array<string,int> */
			public array $expiries_before_pointer_publication = [];

			public function add( string $key, mixed $value, int $expiration = 0 ): bool {
				if ( $this->pointer_key === $key ) {
					$this->keys_before_pointer_publication     = $this->keys();
					$this->expiries_before_pointer_publication = $this->expiries();
				}
				return parent::add( $key, $value, $expiration );
			}
		};
		Core::$memd        = $memd;
		$memd->pointer_key = 'newspack_nodes:sse:v2:publication-host:79:feed9876:0';
		$before            = \time();

		$lease = SSE_Slot_Pool::acquire( 'publication-host', 79, 'feed9876', 1, 83 );

		$this->assertIsArray( $lease );
		$lease_key = "{$memd->pointer_key}:lease:{$lease['owner']}";
		$this->assertSame( [ $lease_key ], $memd->keys_before_pointer_publication );
		$this->assertGreaterThanOrEqual( $before + 83, $memd->expiries_before_pointer_publication[ $lease_key ] );
		$this->assertLessThanOrEqual( \time() + 83, $memd->expiries_before_pointer_publication[ $lease_key ] );
	}

	public function test_liveness_read_error_never_reclaims_a_pointer(): void {
		/** @var InMemoryMemcached $memd */
		$memd        = Core::$memd;
		$pointer_key = 'newspack_nodes:sse:v2:error-host:73:fedcba98:0';
		$old_owner   = 42424243;
		$memd->set( $pointer_key, $old_owner, 0 );
		$memd->fail_get( "{$pointer_key}:lease:{$old_owner}", \Memcached::RES_TIMEOUT );

		$this->assertFalse( SSE_Slot_Pool::acquire( 'error-host', 73, 'fedcba98', 1, 47 ) );
		$this->assertSame( $old_owner, $memd->get( $pointer_key ) );
		$this->assertSame( [ $pointer_key ], $memd->keys(), 'the unused staged liveness key must be removed on read error' );
	}

	public function test_lost_cas_contention_removes_the_staged_liveness_key(): void {
		$memd = new class() extends InMemoryMemcached {
			public string $pointer_key = '';

			public int $winning_owner = 51515153;

			private bool $contended = false;

			public function cas( string|int|float $cas_token, string $key, mixed $value, int $expiration = 0 ): bool {
				if ( ! $this->contended && $this->pointer_key === $key ) {
					$this->contended = true;
					parent::set( $key, $this->winning_owner, 0 );
					parent::set( "{$key}:lease:{$this->winning_owner}", 1, 83 );
					return false;
				}
				return parent::cas( $cas_token, $key, $value, $expiration );
			}
		};
		Core::$memd      = $memd;
		$pointer_key     = 'newspack_nodes:sse:v2:contention-host:73:fedcba98:0';
		$old_owner       = 42424243;
		$memd->pointer_key = $pointer_key;
		$memd->set( $pointer_key, $old_owner, 0 );

		$this->assertFalse( SSE_Slot_Pool::acquire( 'contention-host', 73, 'fedcba98', 1, 47 ) );
		$this->assertSame( $memd->winning_owner, $memd->get( $pointer_key ) );
		$this->assertSame(
			[
				$pointer_key,
				"{$pointer_key}:lease:{$memd->winning_owner}",
			],
			$memd->keys()
		);
	}

	public function test_acquire_refuses_to_return_after_staged_liveness_disappears(): void {
		$memd = new class() extends InMemoryMemcached {
			public string $pointer_key = '';

			private bool $dropped_liveness = false;

			public function get( string $key, ?callable $cache_cb = null, int $get_flags = 0 ): mixed {
				$value = parent::get( $key, $cache_cb, $get_flags );
				if ( ! $this->dropped_liveness && $this->pointer_key === $key && \is_int( $value ) && $value > 0 ) {
					$this->dropped_liveness = true;
					foreach ( $this->keys() as $stored_key ) {
						if ( \str_starts_with( $stored_key, "{$this->pointer_key}:lease:" ) ) {
							$this->delete( $stored_key );
						}
					}
				}
				return $value;
			}
		};
		Core::$memd        = $memd;
		$memd->pointer_key = 'newspack_nodes:sse:v2:staged-host:73:fedcba98:0';

		$this->assertFalse( SSE_Slot_Pool::acquire( 'staged-host', 73, 'fedcba98', 1, 47 ) );
		$this->assertCount( 1, $memd->keys(), 'only the now-dead pointer may remain after staged liveness disappears' );
		$this->assertIsInt( $memd->get( $memd->pointer_key ) );
	}

	public function test_acquire_revalidates_pointer_after_final_staged_liveness_read(): void {
		$memd = new class() extends InMemoryMemcached {
			public string $pointer_key = '';

			public int $replacement_owner = 73737379;

			public int $replacement_value = 91919197;

			public int $replacement_ttl = 89;

			public ?string $staged_lease_key = null;

			private bool $replaced = false;

			public function get( string $key, ?callable $cache_cb = null, int $get_flags = 0 ): mixed {
				$value = parent::get( $key, $cache_cb, $get_flags );
				if (
					! $this->replaced
					&& \str_starts_with( $key, "{$this->pointer_key}:lease:" )
					&& false !== $value
					&& false !== parent::get( $this->pointer_key )
				) {
					$this->replaced         = true;
					$this->staged_lease_key = $key;
					parent::set( $this->pointer_key, $this->replacement_owner, 0 );
					parent::set( "{$this->pointer_key}:lease:{$this->replacement_owner}", $this->replacement_value, $this->replacement_ttl );
				}
				return $value;
			}
		};
		Core::$memd        = $memd;
		$memd->pointer_key = 'newspack_nodes:sse:v2:final-read-host:79:feed9876:0';
		$before            = \time();

		$this->assertFalse( SSE_Slot_Pool::acquire( 'final-read-host', 79, 'feed9876', 1, 83 ) );

		$replacement_key = "{$memd->pointer_key}:lease:{$memd->replacement_owner}";
		$this->assertNotNull( $memd->staged_lease_key );
		$this->assertSame( $memd->replacement_owner, $memd->get( $memd->pointer_key ) );
		$this->assertSame( $memd->replacement_value, $memd->get( $replacement_key ) );
		$this->assertFalse( $memd->get( $memd->staged_lease_key ) );
		$this->assertGreaterThanOrEqual( $before + $memd->replacement_ttl, $memd->expiries()[ $replacement_key ] );
		$this->assertLessThanOrEqual( \time() + $memd->replacement_ttl, $memd->expiries()[ $replacement_key ] );
	}

	public function test_check_reverifies_pointer_after_reading_liveness(): void {
		$memd = new class() extends InMemoryMemcached {
			public string $pointer_key = '';

			public string $watched_lease_key = '';

			public int $replacement_owner = 51515153;

			private bool $replaced = false;

			public function get( string $key, ?callable $cache_cb = null, int $get_flags = 0 ): mixed {
				$value = parent::get( $key, $cache_cb, $get_flags );
				if ( ! $this->replaced && $this->watched_lease_key === $key ) {
					$this->replaced = true;
					parent::set( $this->pointer_key, $this->replacement_owner, 0 );
					parent::set( "{$this->pointer_key}:lease:{$this->replacement_owner}", 1, 83 );
				}
				return $value;
			}
		};
		Core::$memd            = $memd;
		$pointer_key           = 'newspack_nodes:sse:v2:check-host:73:fedcba98:0';
		$old_owner             = 42424243;
		$memd->pointer_key     = $pointer_key;
		$memd->watched_lease_key = "{$pointer_key}:lease:{$old_owner}";
		$memd->set( $pointer_key, $old_owner, 0 );
		$memd->set( $memd->watched_lease_key, 1, 83 );

		$this->assertFalse( SSE_Slot_Pool::check( 'check-host', 73, 'fedcba98', 0, $old_owner ) );
		$this->assertTrue( SSE_Slot_Pool::check( 'check-host', 73, 'fedcba98', 0, $memd->replacement_owner ) );
	}

	public function test_touch_checks_pointer_before_refreshing_stale_liveness(): void {
		$pointer_key   = 'newspack_nodes:sse:v2:lease-host:17:abc12345:0';
		$stale_owner   = 42424243;
		$current_owner = 51515153;
		$stale_key     = "{$pointer_key}:lease:{$stale_owner}";
		$current_key   = "{$pointer_key}:lease:{$current_owner}";
		Core::$memd->set( $pointer_key, $current_owner, 0 );
		Core::$memd->set( $stale_key, 1, 83 );
		Core::$memd->set( $current_key, 73737379, 83 );
		$replacement_value  = Core::$memd->get( $current_key );
		$expiries           = Core::$memd->expiries();
		$stale_expiry       = $expiries[ $stale_key ];
		$replacement_expiry = $expiries[ $current_key ];

		$this->assertFalse( SSE_Slot_Pool::touch( 'lease-host', 17, 'abc12345', 0, $stale_owner, 47 ) );
		$this->assertSame( $stale_expiry, Core::$memd->expiries()[ $stale_key ], 'a stale touch must not refresh even its obsolete liveness key' );
		$this->assertSame( $current_owner, Core::$memd->get( $pointer_key ) );
		$this->assertSame( $replacement_value, Core::$memd->get( $current_key ) );
		$this->assertSame( $replacement_expiry, Core::$memd->expiries()[ $current_key ] );
		$this->assertTrue( SSE_Slot_Pool::check( 'lease-host', 17, 'abc12345', 0, $current_owner ) );
	}

	public function test_touch_read_error_after_refresh_removes_only_the_callers_liveness(): void {
		$memd = new class() extends InMemoryMemcached {
			public string $pointer_key = '';

			public int $pointer_reads = 0;

			/** @var list<array{key:string,expiration:int,result:bool}> */
			public array $touch_calls = [];

			/** @var list<string> */
			public array $delete_calls = [];

			public function get( string $key, ?callable $cache_cb = null, int $get_flags = 0 ): mixed {
				if ( $this->pointer_key === $key ) {
					++$this->pointer_reads;
				}
				return parent::get( $key, $cache_cb, $get_flags );
			}

			public function touch( string $key, int $expiration = 0 ): bool {
				$result              = parent::touch( $key, $expiration );
				$this->touch_calls[] = [
					'key'        => $key,
					'expiration' => $expiration,
					'result'     => $result,
				];
				return $result;
			}

			public function delete( string $key, int $time = 0 ): bool {
				$this->delete_calls[] = $key;
				return parent::delete( $key, $time );
			}
		};
		Core::$memd           = $memd;
		$hostname             = 'touch-error-host';
		$user_id              = 79;
		$ip_hash              = 'face2468';
		$slot                 = 6;
		$owner                = 62626267;
		$other_owner          = 84848489;
		$touch_ttl            = 97;
		$pointer_key          = "newspack_nodes:sse:v2:{$hostname}:{$user_id}:{$ip_hash}:{$slot}";
		$caller_liveness_key  = "{$pointer_key}:lease:{$owner}";
		$other_liveness_key   = "{$pointer_key}:lease:{$other_owner}";
		$other_liveness_value = 91919197;
		$memd->pointer_key    = $pointer_key;
		$memd->set( $pointer_key, $owner, 0 );
		$memd->set( $caller_liveness_key, 31313137, 83 );
		$memd->set( $other_liveness_key, $other_liveness_value, 131 );
		$other_liveness_expiry = $memd->expiries()[ $other_liveness_key ];
		$memd->after_touch_read = static function () use ( $memd, $pointer_key ): void {
			$memd->fail_next_get( $pointer_key, \Memcached::RES_TIMEOUT );
		};

		$result = SSE_Slot_Pool::touch( $hostname, $user_id, $ip_hash, $slot, $owner, $touch_ttl );

		$this->assertFalse( $result );
		$this->assertSame( 2, $memd->pointer_reads, 'touch must read the pointer once before and once after refreshing liveness' );
		$this->assertSame(
			[
				[
					'key'        => $caller_liveness_key,
					'expiration' => $touch_ttl,
					'result'     => true,
				],
			],
			$memd->touch_calls,
			'the caller liveness refresh must succeed before final ownership becomes unverifiable'
		);
		$this->assertSame( [ $caller_liveness_key ], $memd->delete_calls, 'failed final verification must attempt caller-liveness cleanup' );
		$this->assertFalse( $memd->get( $caller_liveness_key ) );
		$this->assertSame( $owner, $memd->get( $pointer_key ), 'touch must never mutate the slot pointer' );
		$this->assertSame( $other_liveness_value, $memd->get( $other_liveness_key ) );
		$this->assertSame( $other_liveness_expiry, $memd->expiries()[ $other_liveness_key ] );
	}

	public function test_stale_release_cannot_tombstone_or_delete_a_replacement_lease(): void {
		$pointer_key   = 'newspack_nodes:sse:v2:lease-host:17:abc12345:0';
		$stale_owner   = 42424243;
		$current_owner = 51515153;
		$stale_key     = "{$pointer_key}:lease:{$stale_owner}";
		$current_key   = "{$pointer_key}:lease:{$current_owner}";
		Core::$memd->set( $pointer_key, $current_owner, 0 );
		Core::$memd->set( $stale_key, 1, 83 );
		Core::$memd->set( $current_key, 1, 83 );
		$expiries = Core::$memd->expiries();

		$this->assertFalse( SSE_Slot_Pool::release( 'lease-host', 17, 'abc12345', 0, $stale_owner ) );
		$this->assertSame( $current_owner, Core::$memd->get( $pointer_key ) );
		$this->assertSame( 1, Core::$memd->get( $stale_key ) );
		$this->assertSame( $expiries[ $stale_key ], Core::$memd->expiries()[ $stale_key ] );
		$this->assertSame( $expiries[ $current_key ], Core::$memd->expiries()[ $current_key ] );
		$this->assertTrue( SSE_Slot_Pool::check( 'lease-host', 17, 'abc12345', 0, $current_owner ) );
	}

	public function test_reserved_tombstone_cannot_be_released_as_an_owner(): void {
		$pointer_key = 'newspack_nodes:sse:v2:lease-host:17:abc12345:0';
		Core::$memd->set( $pointer_key, 0, 0 );

		$this->assertFalse( SSE_Slot_Pool::release( 'lease-host', 17, 'abc12345', 0, 0 ) );
		$this->assertSame( 0, Core::$memd->get( $pointer_key ) );
	}

	public function test_apcu_style_touch_release_interleaving_cleans_obsolete_liveness(): void {
		/** @var InMemoryMemcached $memd */
		$memd = Core::$memd;
		$first = SSE_Slot_Pool::acquire( 'interleave-host', 73, 'fedcba98', 1, 83 );
		$this->assertIsArray( $first );
		$pointer_key = 'newspack_nodes:sse:v2:interleave-host:73:fedcba98:0';
		$stale_key   = "{$pointer_key}:lease:{$first['owner']}";
		$replacement = false;
		$release_result = false;
		$released_pointer = null;

		$memd->after_touch_read = function ( string $key, mixed $value, int $expiration ) use ( $memd, $first, $pointer_key, &$replacement, &$release_result, &$released_pointer ): void {
			$release_result   = SSE_Slot_Pool::release( 'interleave-host', 73, 'fedcba98', $first['slot'], $first['owner'] );
			$released_pointer = $memd->get( $pointer_key );
			$replacement      = SSE_Slot_Pool::acquire( 'interleave-host', 73, 'fedcba98', 1, 47 );
		};

		$this->assertFalse( SSE_Slot_Pool::touch( 'interleave-host', 73, 'fedcba98', $first['slot'], $first['owner'], 47 ) );
		$this->assertTrue( $release_result );
		$this->assertSame( 0, $released_pointer, 'release must tombstone before a replacement can acquire' );
		$this->assertIsArray( $replacement );
		$this->assertFalse( $memd->get( $stale_key ), 'post-touch ownership loss must remove liveness resurrected by APCu-style store' );
		$this->assertTrue( SSE_Slot_Pool::check( 'interleave-host', 73, 'fedcba98', $replacement['slot'], $replacement['owner'] ) );
	}

	public function test_apcu_only_pool_lifecycle_uses_tombstone_release_and_reacquire(): void {
		if ( ! \function_exists( 'apcu_enabled' ) || ! \apcu_enabled() ) {
			$this->markTestSkipped( 'APCu not usable in this SAPI (needs apc.enable_cli=1)' );
		}
		Cache_Backend::$apcu_usable = null;
		Core::$memd                 = null;
		$hostname                   = 'apcu-lease-host-' . \getmypid();
		$user_id                    = 79;
		$ip_hash                    = 'apcu9876';
		$pointer_key                = "newspack_nodes:sse:v2:{$hostname}:{$user_id}:{$ip_hash}:0";
		$owners                     = [];
		\apcu_delete( $pointer_key );

		try {
			$first = SSE_Slot_Pool::acquire( $hostname, $user_id, $ip_hash, 1, 47 );
			$this->assertIsArray( $first );
			$owners[] = $first['owner'];
			$this->assertTrue( SSE_Slot_Pool::check( $hostname, $user_id, $ip_hash, $first['slot'], $first['owner'] ) );
			$this->assertTrue( SSE_Slot_Pool::touch( $hostname, $user_id, $ip_hash, $first['slot'], $first['owner'], 47 ) );
			$this->assertTrue( SSE_Slot_Pool::release( $hostname, $user_id, $ip_hash, $first['slot'], $first['owner'] ) );
			$this->assertSame( 0, \apcu_fetch( $pointer_key ) );
			$this->assertFalse( \apcu_exists( "{$pointer_key}:lease:{$first['owner']}" ) );

			$replacement = SSE_Slot_Pool::acquire( $hostname, $user_id, $ip_hash, 1, 47 );
			$this->assertIsArray( $replacement );
			$owners[] = $replacement['owner'];
			$this->assertNotSame( $first['owner'], $replacement['owner'] );
			$this->assertTrue( SSE_Slot_Pool::check( $hostname, $user_id, $ip_hash, $replacement['slot'], $replacement['owner'] ) );
		} finally {
			\apcu_delete( $pointer_key );
			foreach ( $owners as $owner ) {
				\apcu_delete( "{$pointer_key}:lease:{$owner}" );
			}
		}
	}

	// ── fail-closed when Core::$memd is null ─────────────────────────────────

	public function test_acquire_fails_closed_when_memd_null(): void {
		Core::$memd = null;
		$this->assertFalse( SSE_Slot_Pool::acquire( 'lease-host', 17, 'abc12345', 8, 47 ) );
	}

	public function test_check_fails_closed_when_memd_null(): void {
		Core::$memd = null;
		$this->assertFalse( SSE_Slot_Pool::check( 'lease-host', 17, 'abc12345', 0, 42424243 ) );
	}

	public function test_release_fails_open_when_memd_null(): void {
		Core::$memd = null;
		$this->assertTrue( SSE_Slot_Pool::release( 'lease-host', 17, 'abc12345', 0, 42424243 ) );
	}

	public function test_touch_fails_closed_when_memd_null(): void {
		Core::$memd = null;
		$this->assertFalse( SSE_Slot_Pool::touch( 'lease-host', 17, 'abc12345', 0, 42424243, 47 ) );
	}

	// ── failure-only lease inspection ─────────────────────────────────────────

	public function test_inspect_reports_an_unavailable_backend_when_no_cache_exists(): void {
		Core::$memd = null;

		$this->assertSame(
			[
				'backend'    => 'unavailable',
				'lease_state' => 'backend_read_error',
			],
			$this->inspect_lease( 73737379 )
		);
	}

	public function test_inspect_distinguishes_a_missing_pointer(): void {
		$this->assertSame(
			[
				'backend'    => 'memcached',
				'lease_state' => 'pointer_missing',
			],
			$this->inspect_lease( 42424243 )
		);
	}

	public function test_inspect_distinguishes_a_pointer_owner_mismatch(): void {
		Core::$memd->set( $this->diagnostic_pointer_key(), 51515153, 0 );

		$this->assertSame(
			[
				'backend'    => 'memcached',
				'lease_state' => 'pointer_owner_mismatch',
			],
			$this->inspect_lease( 42424243 )
		);
	}

	public function test_inspect_distinguishes_missing_owner_liveness(): void {
		Core::$memd->set( $this->diagnostic_pointer_key(), 42424243, 0 );

		$this->assertSame(
			[
				'backend'    => 'memcached',
				'lease_state' => 'liveness_missing',
			],
			$this->inspect_lease( 42424243 )
		);
	}

	public function test_inspect_reports_memcached_backend_read_errors_without_keys_or_owners(): void {
		$memd = new class() extends InMemoryMemcached {
			public function getResultMessage(): string {
				return 'SERVER READ FAILED 731';
			}
		};
		Core::$memd = $memd;
		$memd->fail_get( $this->diagnostic_pointer_key(), \Memcached::RES_TIMEOUT );

		$this->assertSame(
			[
				'backend'                   => 'memcached',
				'lease_state'                => 'backend_read_error',
				'memcached_result_code'      => \Memcached::RES_TIMEOUT,
				'memcached_result_message'   => 'SERVER READ FAILED 731',
			],
			$this->inspect_lease( 42424243 )
		);
	}

	public function test_inspect_reports_a_lease_that_recovered_before_inspection(): void {
		$pointer_key = $this->diagnostic_pointer_key();
		Core::$memd->set( $pointer_key, 42424243, 0 );
		Core::$memd->set( "{$pointer_key}:lease:42424243", 1, 47 );

		$this->assertSame(
			[
				'backend'    => 'memcached',
				'lease_state' => 'recovered_during_inspection',
			],
			$this->inspect_lease( 42424243 )
		);
	}

	// ── wire() installs the SSE_Out seams ────────────────────────────────────

	public function test_the_wired_pool_separates_sites_that_share_a_machine(): void {
		// Atomic hands every co-located site the same gethostname() (the pool
		// host), and a hub authenticates as user 1 from one IP on all of them, so
		// a machine-only key collapsed 15 sites onto ONE 10-slot budget — five of
		// them permanently 429'd. Proven in the field: two sites reported the
		// identical random owner id for one slot. The machine half still has to
		// survive; dndocker is the mirror image, many containers sharing one site,
		// one database and one memcached.
		Core::$memd = new InMemoryMemcached();

		// Saturate one site's whole budget.
		$GLOBALS['_wp_test_home_url'] = 'https://leoweekly.example';
		SSE_Slot_Pool::wire();
		for ( $i = 0; $i < SSE_Slot_Pool::$max_slots; $i++ ) {
			$this->assertIsArray( ( SSE_Out_Node::$acquire_slot )( -1 ) );
		}
		$this->assertFalse( ( SSE_Out_Node::$acquire_slot )( -1 ), 'that site is full' );

		// A co-located site — same hostname, same user, same caller IP — has its
		// own budget and is unaffected.
		$GLOBALS['_wp_test_home_url'] = 'https://okgazette.example';
		SSE_Slot_Pool::wire();
		$this->assertIsArray(
			( SSE_Out_Node::$acquire_slot )( -1 ),
			'a neighbour site must not inherit a full pool'
		);

		$machine = \gethostname() ?: 'unknown';
		$this->assertStringContainsString(
			$machine,
			\array_keys( Core::$memd->expiries() )[0],
			'the machine half survives, for one site across many containers'
		);
		unset( $GLOBALS['_wp_test_home_url'] );
	}

	public function test_wire_populates_all_four_seams_with_endpoint_signatures(): void {
		$this->assertNull( SSE_Out_Node::$acquire_slot );
		$this->assertNull( SSE_Out_Node::$release_slot );
		$this->assertNull( SSE_Out_Node::$check_slot );

		SSE_Slot_Pool::wire();

		$this->assertInstanceOf( \Closure::class, SSE_Out_Node::$acquire_slot );
		$this->assertInstanceOf( \Closure::class, SSE_Out_Node::$release_slot );
		$this->assertInstanceOf( \Closure::class, SSE_Out_Node::$check_slot );
		$this->assertTrue( \property_exists( SSE_Out_Node::class, 'inspect_slot' ), 'inspect seam is missing' );
		$this->assertInstanceOf( \Closure::class, SSE_Out_Node::$inspect_slot );
		$this->assertSame( 1, ( new \ReflectionFunction( SSE_Out_Node::$acquire_slot ) )->getNumberOfParameters() );
		$this->assertSame( 2, ( new \ReflectionFunction( SSE_Out_Node::$release_slot ) )->getNumberOfParameters() );
		$this->assertSame( 2, ( new \ReflectionFunction( SSE_Out_Node::$check_slot ) )->getNumberOfParameters() );
		$this->assertSame( 2, ( new \ReflectionFunction( SSE_Out_Node::$inspect_slot ) )->getNumberOfParameters() );
	}

	public function test_wired_seams_reject_an_incomplete_lease(): void {
		SSE_Slot_Pool::wire();
		$release = SSE_Out_Node::$release_slot;

		$this->expectException( \UnexpectedValueException::class );
		$this->expectExceptionMessage( 'SSE slot seam did not receive a complete lease.' );
		$release( [ 'slot' => 73 ], 9 );
	}

	public function test_wired_acquire_claims_a_slot(): void {
		SSE_Slot_Pool::wire();
		$acquire = SSE_Out_Node::$acquire_slot;
		$lease   = $acquire();

		$this->assertIsArray( $lease );
		$this->assertSame( 0, $lease['slot'] );
		$this->assertGreaterThan( 0, $lease['owner'] );
	}

	public function test_wired_release_returns_slot_to_pool(): void {
		SSE_Slot_Pool::wire();
		$acquire = SSE_Out_Node::$acquire_slot;
		$release = SSE_Out_Node::$release_slot;

		$lease = $acquire();
		$this->assertIsArray( $lease );
		$this->assertSame( 0, $lease['slot'] );
		$release( $lease );
		$replacement = $acquire();
		$this->assertIsArray( $replacement );
		$this->assertSame( 0, $replacement['slot'] );
	}

	public function test_wired_check_returns_true_for_held_slot(): void {
		SSE_Slot_Pool::wire();
		$acquire = SSE_Out_Node::$acquire_slot;
		$check   = SSE_Out_Node::$check_slot;

		$lease = $acquire();
		$this->assertIsArray( $lease );
		$this->assertTrue( $check( $lease ) );
	}

	public function test_wired_acquire_returns_false_when_pool_exhausted(): void {
		SSE_Slot_Pool::$max_slots = 2;
		SSE_Slot_Pool::wire();
		$acquire = SSE_Out_Node::$acquire_slot;

		$this->assertNotFalse( $acquire() );
		$this->assertNotFalse( $acquire() );
		$this->assertFalse( $acquire() );
	}

	private function diagnostic_pointer_key(): string {
		return 'newspack_nodes:sse:v2:diagnostic-host:73:fedcba98:7';
	}

	/** @return array<string,int|string> */
	private function inspect_lease( int $owner ): array {
		$this->assertTrue( \method_exists( SSE_Slot_Pool::class, 'inspect' ), 'lease inspection method is missing' );
		return SSE_Slot_Pool::inspect( 'diagnostic-host', 73, 'fedcba98', 7, $owner );
	}
}
