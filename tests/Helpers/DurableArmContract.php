<?php
namespace Newspack_Nodes\Tests\Helpers;

use Newspack_Nodes\Cache_Backend;

/**
 * What a durable arm keeps beyond every arm's contract: it lists its keys in
 * order, reclaims expired rows in batches, and compacts its store. A volatile
 * arm expires on its own and holds no pages, so it runs none of this.
 */
abstract class DurableArmContract extends CacheBackendContract {

	public function test_an_expired_row_is_absent_to_a_scan(): void {
		$arm = $this->arm();
		$arm->write_multi( [ 'kea-exp:n' => 41, 'kea-exp:c' => 43 ], 37 );
		$this->clock += 37;
		$this->assertSame( [], $arm->scan( 'kea-exp:', 10 ) );
	}

	public function test_scan_lists_keys_in_order_up_to_its_limit(): void {
		$arm = $this->arm();
		$arm->write_multi( [ 'urltoken:ab:wombat:c3' => 3, 'urltoken:ab:wolf:c1' => 1, 'urltoken:ab:womb:c2' => 2, 'urltoken:zz:wombat:c9' => 9 ], 600 );
		$this->assertSame( [ 'urltoken:ab:wolf:c1' => 1, 'urltoken:ab:womb:c2' => 2 ], $arm->scan( 'urltoken:ab:', 2 ) );
		$this->assertSame( [ 'urltoken:ab:womb:c2' => 2, 'urltoken:ab:wombat:c3' => 3 ], $arm->scan( 'urltoken:ab:wom', 10 ) );
	}

	public function test_purge_reclaims_expired_rows_a_batch_at_a_time(): void {
		$arm = $this->arm();
		$arm->write_multi( [ 'kea-p1' => 1, 'kea-p2' => 2, 'kea-p3' => 3 ], 37 );
		$arm->set( 'kea-forever', 4, 0 );
		$this->clock += 37;
		$this->assertSame( 2, $arm->purge( (int) $this->clock, 2 ) );
		$this->assertSame( 1, $arm->purge( (int) $this->clock, 2 ) );
		$this->assertSame( 0, $arm->purge( (int) $this->clock, 2 ) );
		$this->assertSame( 4, $arm->get( 'kea-forever' ) );
	}

	public function test_vacuum_keeps_every_live_value(): void {
		$arm = $this->arm();
		$arm->set( 'kea-vac', 41, 600 );
		$arm->vacuum();
		$this->assertSame( 41, $arm->get( 'kea-vac' ) );
	}

	public function test_the_purge_reclaims_what_a_salt_rotation_orphaned(): void {
		$arm = $this->arm();
		$arm->set( Cache_Backend::site_key( 'kea-salted' ), 'before', 37 );
		Cache_Backend::rotate_salt();
		$this->clock += 37;
		$this->assertSame( 1, $arm->purge( (int) $this->clock, 10 ), 'the orphaned row is reclaimed once it expires' );
	}
}
