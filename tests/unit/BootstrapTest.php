<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Bootstrap::class )]
class BootstrapTest extends TestCase {
	public function test_get_topologies_returns_filtered_array(): void {
		$GLOBALS['_wp_actions'] = [];
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['my-group'] = [ 'num_partitions' => 2, 'topology' => '/path/to/file.php' ];
			return $topologies;
		} );

		$result = Bootstrap::get_topologies();
		$this->assertArrayHasKey( 'my-group', $result );
		$this->assertSame( 2, $result['my-group']['num_partitions'] );
	}

	public function test_get_topologies_returns_empty_array_when_no_filter(): void {
		$GLOBALS['_wp_actions'] = [];
		$result = Bootstrap::get_topologies();
		$this->assertSame( [], $result );
	}

	public function test_expand_topologies_yields_one_entry_per_partition(): void {
		$GLOBALS['_wp_actions'] = [];
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['firehose-workers'] = [ 'num_partitions' => 4, 'topology' => '/x.php' ];
			$topologies['job-workers']      = [ 'num_partitions' => 2, 'topology' => '/y.php' ];
			return $topologies;
		} );

		$workers = Bootstrap::expand_workers();
		$this->assertCount( 6, $workers );
		$this->assertSame( 'firehose-workers', $workers[0]['type'] );
		$this->assertSame( 0, $workers[0]['partition'] );
		$this->assertSame( 3, $workers[3]['partition'] );
	}

	public function test_register_cron_schedules_adds_minute_interval(): void {
		$schedules = Bootstrap::register_cron_schedules( [] );
		$this->assertArrayHasKey( 'newspack_nodes_minute', $schedules );
		$this->assertSame( 60, $schedules['newspack_nodes_minute']['interval'] );
	}

	public function test_register_cron_schedules_preserves_existing_entries(): void {
		$existing = [ 'hourly' => [ 'interval' => 3600, 'display' => 'Hourly' ] ];
		$result   = Bootstrap::register_cron_schedules( $existing );
		$this->assertArrayHasKey( 'hourly', $result );
		$this->assertArrayHasKey( 'newspack_nodes_minute', $result );
	}

	public function test_register_cron_schedules_is_idempotent(): void {
		$first  = Bootstrap::register_cron_schedules( [] );
		$second = Bootstrap::register_cron_schedules( $first );
		$this->assertSame( $first, $second, 'second call must not override existing entry' );
	}

	public function test_activate_schedules_supervisor_at_minute_cadence(): void {
		$GLOBALS['_wp_test_next_scheduled']    = false;
		$GLOBALS['_wp_test_scheduled_events']  = [];
		Bootstrap::activate();
		$this->assertNotEmpty( $GLOBALS['_wp_test_scheduled_events'] );
		$evt = $GLOBALS['_wp_test_scheduled_events'][0];
		$this->assertSame( 'newspack_nodes_minute', $evt['recurrence'] );
		$this->assertSame( 'newspack_nodes/supervisor', $evt['hook'] );
	}

	public function test_activate_skipped_when_already_scheduled(): void {
		$GLOBALS['_wp_test_next_scheduled']   = 1234567890;
		$GLOBALS['_wp_test_scheduled_events'] = [];
		Bootstrap::activate();
		$this->assertEmpty( $GLOBALS['_wp_test_scheduled_events'] );
	}
}
