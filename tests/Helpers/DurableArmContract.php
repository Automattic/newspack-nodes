<?php
namespace Newspack_Nodes\Tests\Helpers;

/**
 * What a durable arm keeps beyond every arm's contract: it holds set members,
 * reclaims expired rows in batches and compacts its store. A volatile arm expires on its own
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

	public function test_read_entries_answer_each_live_rows_value_and_remaining_life(): void {
		$arm = $this->arm();
		$arm->set( 'kea-e1', [ 'n' => 41 ], 777 );
		$arm->set( 'kea-e2', 'kea-42', 37 );
		$arm->set( 'kea-forever', 43, 0 );
		$this->clock += 37;
		$this->assertSame(
			[
				'kea-e1'      => [ 'value' => [ 'n' => 41 ], 'ttl' => 740 ],
				'kea-forever' => [ 'value' => 43 ],
			],
			$arm->read_entries( [ 'kea-e1', 'kea-e2', 'kea-forever', 'kea-absent' ] ),
			'an expired row is absent, and a row that never expires states no ttl'
		);
		$this->assertSame( [], $arm->read_entries( [] ) );
	}

	public function test_a_flush_deletes_every_keyed_row_and_member_expired_or_not(): void {
		$arm = $this->arm();
		$arm->write_multi( [ 'kea-f1' => 41, 'kea-f2' => 42 ], 37 );
		$arm->set( 'kea-forever', 43, 0 );
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-44' => 44, 'm-45' => 45 ], 777 ], 'owl:set-9' => [ [ 'm-46' => 46 ], 38 ] ] );
		$this->clock += 37;
		$this->assertNotNull( $arm->flush() );
		$this->assertSame( [], $arm->read_multi( [ 'kea-f1', 'kea-f2', 'kea-forever' ] ) );
		$this->assertSame( [], $arm->members( [ 'owl:set-7', 'owl:set-9' ], 9 ) );
		$this->assertTrue( $arm->set( 'kea-after', 4477, 600 ), 'the flushed store takes a write' );
		$this->assertSame( 4477, $arm->get( 'kea-after' ) );
		$this->assertTrue( $arm->add_members( [ 'owl:set-11' => [ [ 'm-47' => 47 ], 600 ] ] ) );
		$this->assertSame( [ 'owl:set-11' => [ 'm-47' => 47 ] ], $arm->members( [ 'owl:set-11' ], 9 ) );
	}

	public function test_vacuum_keeps_every_live_value(): void {
		$arm = $this->arm();
		$arm->set( 'kea-vac', 41, 600 );
		$arm->vacuum();
		$this->assertSame( 41, $arm->get( 'kea-vac' ) );
	}

	public function test_a_re_added_member_replaces_its_value_and_its_expiry(): void {
		$arm = $this->arm();
		$this->assertTrue( $arm->add_members( [ 'owl:set-7' => [ [ 'm-41' => 'kea', 'm-43' => [ 'n' => 43 ] ], 37 ] ] ) );
		$this->assertTrue( $arm->add_members( [ 'owl:set-7' => [ [ 'm-41' => 'weka' ], 777 ] ] ) );
		$this->clock += 37;
		$this->assertSame( [ 'owl:set-7' => [ 'm-41' => 'weka' ] ], $arm->members( [ 'owl:set-7' ], 9 ), 'm-43 expired; the re-added m-41 took the new expiry' );
	}

	public function test_an_expired_member_is_hidden_and_a_live_one_is_not(): void {
		$arm = $this->arm();
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-41' => 1 ], 37 ], 'owl:set-9' => [ [ 'm-47' => 2 ], 38 ] ] );
		$this->clock += 36;
		$this->assertSame( [ 'owl:set-7' => [ 'm-41' => 1 ], 'owl:set-9' => [ 'm-47' => 2 ] ], $arm->members( [ 'owl:set-7', 'owl:set-9' ], 9 ) );
		$this->clock += 1;
		$this->assertSame( [ 'owl:set-9' => [ 'm-47' => 2 ] ], $arm->members( [ 'owl:set-7', 'owl:set-9' ], 9 ), 'a set with no live member is absent' );
	}

	public function test_a_set_past_the_limit_reads_null_and_one_at_it_reads_whole(): void {
		$arm = $this->arm();
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-1' => 1, 'm-2' => 2, 'm-3' => 3, 'm-4' => 4 ], 777 ], 'owl:set-9' => [ [ 'm-5' => 5, 'm-6' => 6, 'm-8' => 8 ], 777 ] ] );
		$this->assertSame( [ 'owl:set-7' => null, 'owl:set-9' => [ 'm-5' => 5, 'm-6' => 6, 'm-8' => 8 ] ], $arm->members( [ 'owl:set-7', 'owl:set-9' ], 3 ), 'four members are over a limit of 3; three are not' );
		$this->assertSame( [], $arm->members( [ 'owl:set-7' ], 0 ), 'a limit of 0 reads nothing' );
		$this->assertSame( [], $arm->members( [ 'owl:set-7' ], -5 ), 'a negative limit is no limit lifted' );
	}

	public function test_members_come_back_in_member_order(): void {
		$arm = $this->arm();
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-9' => 9, 'm-3' => 3, 'm-7' => 7, 'm-1' => 1 ], 777 ] ] );
		$this->assertSame( [ 'owl:set-7' => [ 'm-1' => 1, 'm-3' => 3, 'm-7' => 7, 'm-9' => 9 ] ], $arm->members( [ 'owl:set-7' ], 4 ) );
	}

	public function test_set_keys_are_isolated_and_an_absent_set_is_absent(): void {
		$arm = $this->arm();
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-41' => 'kea' ], 777 ], 'owl:set-70' => [ [ 'm-43' => 'weka' ], 777 ] ] );
		$this->assertSame( [ 'owl:set-7' => [ 'm-41' => 'kea' ] ], $arm->members( [ 'owl:set-7', 'owl:set-8', 'owl:set-7' ], 9 ), 'a set key is matched whole, never as a prefix' );
		$this->assertSame( [], $arm->members( [], 9 ) );
	}

	public function test_a_member_add_below_one_second_or_under_a_refused_key_writes_nothing(): void {
		$arm = $this->arm();
		$this->assertFalse( $arm->add_members( [ 'owl:set-7' => [ [ 'm-41' => 1 ], 777 ], 'owl:set-9' => [ [ 'm-43' => 2 ], 0 ] ] ) );
		$this->assertFalse( $arm->add_members( [ 'owl:set-7' => [ [ 'm-41' => 1 ], 777 ], 'owl set' => [ [ 'm-43' => 2 ], 777 ] ] ) );
		$this->assertSame( [], $arm->members( [ 'owl:set-7', 'owl:set-9' ], 9 ) );
		$this->assertTrue( $arm->add_members( [] ) );
	}

	public function test_an_all_digit_member_and_set_key_round_trip(): void {
		$arm = $this->arm();
		$arm->add_members( [ '4417' => [ [ '0418' => 'kea', '4419' => 'owl' ], 777 ] ] );
		$this->assertSame( [ '0418' => 'kea', 4419 => 'owl' ], $arm->members( [ '4417' ], 9 )['4417'] );
	}

	public function test_the_purge_reclaims_expired_members_within_the_one_budget(): void {
		$arm = $this->arm();
		$arm->write_multi( [ 'kea-p1' => 1, 'kea-p2' => 2 ], 37 );
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-1' => 1, 'm-2' => 2 ], 37 ], 'owl:set-9' => [ [ 'm-3' => 3 ], 37 ], 'owl:set-11' => [ [ 'm-4' => 4 ], 777 ] ] );
		$this->clock += 37;
		$this->assertSame( 4, $arm->purge( (int) $this->clock, 4 ), 'kv rows and members share the one limit' );
		$this->assertSame( 1, $arm->purge( (int) $this->clock, 4 ) );
		$this->assertSame( 0, $arm->purge( (int) $this->clock, 4 ) );
		$this->assertSame( [ 'owl:set-11' => [ 'm-4' => 4 ] ], $arm->members( [ 'owl:set-11' ], 9 ) );
	}

	public function test_move_members_takes_the_lowest_members_and_keeps_value_and_expiry(): void {
		$arm = $this->arm();
		$this->assertTrue( $arm->add_members( [ 'pend-8812' => [ [ 'm-c' => 'vc-31', 'm-a' => 'va-17', 'm-b' => 'vb-23' ], 4321 ] ] ) );
		$moved = $arm->move_members( 'pend-8812', 'fly-8812', 2 );
		$this->assertSame( [ 'm-a' => 'va-17', 'm-b' => 'vb-23' ], $moved );
		$this->assertSame( [ 'pend-8812' => [ 'm-c' => 'vc-31' ], 'fly-8812' => [ 'm-a' => 'va-17', 'm-b' => 'vb-23' ] ], $arm->members( [ 'pend-8812', 'fly-8812' ], 10 ) );
		$this->clock += 4320;
		$this->assertSame( [ 'm-a' => 'va-17', 'm-b' => 'vb-23' ], $arm->members( [ 'fly-8812' ], 10 )['fly-8812'], 'the moved rows keep the add\'s expiry' );
		$this->clock += 1;
		$this->assertSame( [], $arm->members( [ 'pend-8812', 'fly-8812' ], 10 ), 'and expire with it' );
	}

	public function test_move_members_skips_expired_members_and_overwrites_a_member_already_there(): void {
		$arm = $this->arm();
		$arm->add_members( [ 'pend-3305' => [ [ 'm-a' => 'old-1' ], 37 ] ] );
		$arm->add_members( [ 'pend-3305' => [ [ 'm-b' => 'vb-5', 'm-c' => 'vc-6' ], 777 ] ] );
		$arm->add_members( [ 'fly-3305' => [ [ 'm-b' => 'stale-9' ], 777 ] ] );
		$this->clock += 37;
		$this->assertSame( [ 'm-b' => 'vb-5', 'm-c' => 'vc-6' ], $arm->move_members( 'pend-3305', 'fly-3305', 9 ) );
		$this->assertSame( [ 'fly-3305' => [ 'm-b' => 'vb-5', 'm-c' => 'vc-6' ] ], $arm->members( [ 'pend-3305', 'fly-3305' ], 10 ) );
	}

	public function test_move_members_of_an_empty_set_or_a_refused_request_moves_nothing(): void {
		$arm = $this->arm();
		$this->assertSame( [], $arm->move_members( 'none-4471', 'fly-4471', 5 ) );
		$arm->add_members( [ 'pend-4471' => [ [ 'm-1' => 1 ], 600 ] ] );
		$this->assertSame( [], $arm->move_members( 'pend-4471', 'fly-4471', 0 ) );
		$this->assertSame( [], $arm->move_members( 'pend-4471', 'fly 4471', 3 ) );
		$this->assertSame( [ 'pend-4471' => [ 'm-1' => 1 ] ], $arm->members( [ 'pend-4471', 'fly-4471' ], 10 ) );
	}

	public function test_remove_members_names_what_was_there(): void {
		$arm = $this->arm();
		$arm->add_members( [ 'fly-6630' => [ [ 'u-1' => 1, 'u-2' => 1 ], 600 ] ] );
		$this->assertSame( [ 'u-2' ], $arm->remove_members( 'fly-6630', [ 'u-2', 'u-9' ] ) );
		$this->assertSame( [ 'fly-6630' => [ 'u-1' => 1 ] ], $arm->members( [ 'fly-6630' ], 10 ) );
		$this->assertSame( [], $arm->remove_members( 'fly-6630', [] ) );
		$this->assertSame( [], $arm->remove_members( 'fly 6630', [ 'u-1' ] ) );
	}
}
