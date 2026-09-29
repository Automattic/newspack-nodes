<?php
namespace Newspack_Nodes\Tests\Helpers;

use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;

/**
 * The one contract every Cache_Backend arm keeps. A subclass builds its arm;
 * an arm whose expiry a test cannot move says so through `moves_clock()`.
 * What only a durable arm does — list, purge, vacuum — is DurableArmContract's.
 */
abstract class CacheBackendContract extends TestCase {

	/** Epoch second every contract test starts at. */
	protected const T0 = 1790000000;

	protected float $clock = self::T0;

	abstract protected function arm(): Cache_Backend;

	/** Whether a failed batch write lands nothing. */
	protected function batches_atomically(): bool {
		return false;
	}

	/** Whether a test can move the arm's expiry clock. */
	protected function moves_clock(): bool {
		return true;
	}

	protected function setUp(): void {
		parent::setUp();
		$this->clock = self::T0;
		Core::$clock = fn (): float => $this->clock;
	}

	public function test_a_value_past_its_ttl_reads_as_absent(): void {
		if ( ! $this->moves_clock() ) {
			$this->markTestSkipped( 'this arm expires on a clock no test moves' );
		}
		$arm = $this->arm();
		$this->assertTrue( $arm->set( 'kea-ttl', [ 'n' => 41 ], 37 ) );
		$this->clock += 36;
		$this->assertSame( [ 'n' => 41 ], $arm->get( 'kea-ttl' ) );
		$this->clock += 1;
		$this->assertFalse( $arm->get( 'kea-ttl' ) );
		$this->assertSame( Cache_Backend::READ_MISS, $arm->read( 'kea-ttl' )['status'] );
		$this->assertSame( [], $arm->read_multi( [ 'kea-ttl' ] ) );
	}

	public function test_an_expired_row_is_absent_to_every_verb(): void {
		if ( ! $this->moves_clock() ) {
			$this->markTestSkipped( 'this arm expires on a clock no test moves' );
		}
		$arm = $this->arm();
		$arm->write_multi( [ 'kea-exp:n' => 41, 'kea-exp:c' => 43, 'kea-exp:t' => 1, 'kea-exp:d' => 2 ], 37 );
		$this->clock += 37;
		$this->assertFalse( $arm->touch( 'kea-exp:t', 777 ) );
		$this->assertFalse( $arm->increment( 'kea-exp:n' ) );
		$this->assertFalse( $arm->decrement( 'kea-exp:n' ) );
		$this->assertFalse( $arm->compare_and_swap( 'kea-exp:c', 43, 47 ) );
		$this->assertFalse( $arm->delete( 'kea-exp:d' ) );
	}

	public function test_read_tells_a_hit_from_a_miss(): void {
		$arm = $this->arm();
		$arm->set( 'kea-read', false, 600 );
		$this->assertSame( [ 'status' => Cache_Backend::READ_HIT, 'value' => false ], $arm->read( 'kea-read' ) );
		$this->assertSame( [ 'status' => Cache_Backend::READ_MISS, 'value' => null ], $arm->read( 'kea-read-none' ) );
	}

	public function test_delete_removes_a_key_and_reports_an_absent_one(): void {
		$arm = $this->arm();
		$arm->set( 'kea-del', 'v', 600 );
		$this->assertTrue( $arm->delete( 'kea-del' ) );
		$this->assertFalse( $arm->get( 'kea-del' ) );
		$this->assertFalse( $arm->delete( 'kea-del' ) );
		$this->assertFalse( $arm->delete( 'kea-never-set' ) );
	}

	public function test_add_writes_only_where_absent(): void {
		$arm = $this->arm();
		$this->assertTrue( $arm->add( 'kea-add', 'first', 37 ) );
		$this->assertFalse( $arm->add( 'kea-add', 'second', 37 ) );
		$this->assertSame( 'first', $arm->get( 'kea-add' ) );
		if ( $this->moves_clock() ) {
			$this->clock += 37;
			$this->assertTrue( $arm->add( 'kea-add', 'third', 37 ), 'an expired value is absent to add' );
			$this->assertSame( 'third', $arm->get( 'kea-add' ) );
		}
	}

	public function test_touch_moves_expiry_and_reports_an_absent_key(): void {
		$arm = $this->arm();
		$arm->set( 'kea-touch', 'v', 37 );
		$this->assertTrue( $arm->touch( 'kea-touch', 600 ) );
		$this->assertFalse( $arm->touch( 'kea-never', 600 ) );
		if ( $this->moves_clock() ) {
			$this->clock += 300;
			$this->assertSame( 'v', $arm->get( 'kea-touch' ) );
		}
	}

	public function test_the_arm_declares_whether_a_batch_is_atomic(): void {
		$this->assertSame( $this->batches_atomically(), $this->arm()->batch_is_atomic() );
	}

	public function test_salt_rotation_moves_every_key(): void {
		$arm = $this->arm();
		$arm->set( Cache_Backend::site_key( 'kea-salted' ), 'before', 37 );
		Cache_Backend::rotate_salt();
		$this->assertFalse( $arm->get( Cache_Backend::site_key( 'kea-salted' ) ) );
	}

	public function test_every_write_refuses_a_key_holding_whitespace(): void {
		$arm = $this->arm();
		$this->assertFalse( $arm->set( 'kea 41', 1, 37 ) );
		$this->assertFalse( $arm->add( "kea\n42", 1, 37 ) );
		$this->assertFalse( $arm->write_multi( [ 'kea-43' => 1, "kea\t44" => 2 ], 37 ) );
		$this->assertFalse( $arm->get( 'kea-43' ), 'a refused batch writes nothing' );
	}

	public function test_read_multi_returns_found_keys_only_across_a_wide_batch(): void {
		$items = [];
		for ( $i = 0; $i < 2345; ++$i ) {
			$items[ "kea-wide-{$i}" ] = $i;
		}
		$arm = $this->arm();
		$this->assertTrue( $arm->write_multi( $items, 600 ) );
		$found = $arm->read_multi( [ ...\array_keys( $items ), 'kea-absent' ], $failed );
		$this->assertFalse( $failed );
		$this->assertCount( 2345, $found );
		$this->assertSame( 2344, $found['kea-wide-2344'] );
	}

	public function test_counters_refuse_an_absent_key_and_clamp_at_zero(): void {
		$arm = $this->arm();
		$this->assertFalse( $arm->increment( 'kea-none' ) );
		$arm->set( 'kea-n', 1, 600 );
		$this->assertSame( 2, $arm->increment( 'kea-n' ) );
		$this->assertSame( 1, $arm->decrement( 'kea-n' ) );
		$this->assertSame( 0, $arm->decrement( 'kea-n' ) );
		$this->assertSame( 0, $arm->decrement( 'kea-n' ) );
	}

	public function test_compare_and_swap_replaces_only_the_expected_integer(): void {
		$arm = $this->arm();
		$arm->set( 'kea-ptr', 41, 0 );
		$this->assertFalse( $arm->compare_and_swap( 'kea-ptr', 40, 43 ) );
		$this->assertTrue( $arm->compare_and_swap( 'kea-ptr', 41, 43 ) );
		$this->assertSame( 43, $arm->get( 'kea-ptr' ) );
	}
}
