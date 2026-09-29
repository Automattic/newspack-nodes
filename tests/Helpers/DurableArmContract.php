<?php
namespace Newspack_Nodes\Tests\Helpers;

use Newspack_Nodes\Cache_Backend;

/**
 * What a durable arm keeps beyond every arm's contract: it reclaims expired
 * rows in batches and compacts its store. A volatile arm expires on its own
 * and holds no pages, so it runs none of this.
 */
abstract class DurableArmContract extends CacheBackendContract {

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
