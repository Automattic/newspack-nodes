<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversTrait;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Node;
use Newspack_Nodes\Publishes_Status;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/** A node publishing its status under a TTL and a heartbeat of its own. */
final class Status_Fixture_Node extends Node {
	use Publishes_Status;

	/** @param array<string,mixed> $data Fields to publish. */
	public function publish( array $data ): void {
		$this->publish_status( $data );
	}

	/** @return array<array-key,mixed> */
	public function held(): array {
		return $this->last_status();
	}

	protected function status_ttl(): int {
		return 7777;
	}

	protected function status_heartbeat(): int {
		return 33;
	}
}

/**
 * A node's status snapshot in the shared cache: merged over the last one,
 * written on change or once a heartbeat, read back on a process's first call,
 * and published only from a worker with a shared cache to publish into.
 */
#[CoversTrait( Publishes_Status::class )]
class PublishesStatusTest extends TestCase {

	private InMemoryMemcached $memd;

	protected function setUp(): void {
		parent::setUp();
		$this->memd             = new InMemoryMemcached();
		Core::$memd             = $this->memd;
		Core::$var['partition'] = '3';
		Core::$now              = 6100.0;
	}

	protected function tearDown(): void {
		unset( Core::$var['partition'] );
		Core::$memd = null;
		parent::tearDown();
	}

	private static function fixture(): Status_Fixture_Node {
		$node = new Status_Fixture_Node();
		$node->name( 'fx' );
		return $node;
	}

	public function test_status_key_is_site_scoped_by_name_and_partition(): void {
		$this->assertSame( Cache_Backend::site_key( 'status:fx:p3' ), Status_Fixture_Node::status_key( 'fx', 3 ) );
	}

	public function test_publish_writes_merged_snapshot_under_status_key(): void {
		self::fixture()->publish( [ 'a' => 'x9' ] );

		$this->assertSame( [ 'a' => 'x9' ], Status_Fixture_Node::read_status( 'fx', 3 ) );
		$this->assertSame( Status_Fixture_Node::status_key( 'fx', 3 ), $this->memd->sets[0]['key'] );
	}

	public function test_unchanged_snapshot_is_not_rewritten_before_heartbeat(): void {
		$node = self::fixture();
		$node->publish( [ 'a' => 'x9' ] );
		Core::$now += 32;
		$node->publish( [ 'a' => 'x9' ] );

		$this->assertCount( 1, $this->memd->sets );
	}

	public function test_unchanged_snapshot_is_rewritten_after_heartbeat(): void {
		$node = self::fixture();
		$node->publish( [ 'a' => 'x9' ] );
		Core::$now += 33;
		$node->publish( [ 'a' => 'x9' ] );

		$this->assertCount( 2, $this->memd->sets );
	}

	public function test_a_changed_snapshot_is_written_at_once(): void {
		$node = self::fixture();
		$node->publish( [ 'a' => 'x9' ] );
		Core::$now += 1;
		$node->publish( [ 'b' => 'k4' ] );

		$this->assertCount( 2, $this->memd->sets );
		$this->assertSame( [ 'a' => 'x9', 'b' => 'k4' ], Status_Fixture_Node::read_status( 'fx', 3 ) );
	}

	public function test_ttl_is_the_class_ttl(): void {
		self::fixture()->publish( [ 'a' => 'x9' ] );

		$this->assertSame( 7777, $this->memd->sets[0]['ttl'] );
	}

	public function test_new_process_reads_back_and_merges(): void {
		$this->memd->set( Status_Fixture_Node::status_key( 'fx', 3 ), [ 'a' => 'x9', 'since' => 4242 ], 60 );

		self::fixture()->publish( [ 'a' => 'y7' ] );

		$this->assertSame( [ 'a' => 'y7', 'since' => 4242 ], Status_Fixture_Node::read_status( 'fx', 3 ) );
	}

	public function test_the_snapshot_is_read_back_once_a_process(): void {
		$node = self::fixture();
		$node->publish( [ 'a' => 'x9' ] );
		$this->memd->set( Status_Fixture_Node::status_key( 'fx', 3 ), [ 'a' => 'ext-2', 'z' => 'q2' ], 60 );
		Core::$now += 1;
		$node->publish( [ 'b' => 'k4' ] );

		$this->assertSame( 1, $this->memd->get_calls );
		$this->assertSame( [ 'a' => 'x9', 'b' => 'k4' ], Status_Fixture_Node::read_status( 'fx', 3 ) );
	}

	public function test_a_renamed_node_reads_back_and_writes_under_its_new_key(): void {
		$node = self::fixture();
		$node->publish( [ 'a' => 'x9' ] );
		$this->memd->set( Status_Fixture_Node::status_key( 'fz-41', 3 ), [ 'since' => 8181 ], 60 );

		$node->name( 'fz-41' );
		Core::$now += 1;
		$node->publish( [ 'a' => 'x9' ] );

		$this->assertSame( [ 'since' => 8181, 'a' => 'x9' ], Status_Fixture_Node::read_status( 'fz-41', 3 ) );
	}

	public function test_last_status_reads_back_the_cached_snapshot(): void {
		$this->memd->set( Status_Fixture_Node::status_key( 'fx', 3 ), [ 'since' => 5353 ], 60 );

		$this->assertSame( [ 'since' => 5353 ], self::fixture()->held() );
	}

	public function test_last_status_is_empty_outside_a_worker(): void {
		$this->memd->set( Status_Fixture_Node::status_key( 'fx', 3 ), [ 'since' => 5353 ], 60 );
		unset( Core::$var['partition'] );

		$this->assertSame( [], self::fixture()->held() );
	}

	public function test_no_shared_cache_publishes_nothing_and_reads_null(): void {
		Core::$memd = null;

		self::fixture()->publish( [ 'a' => 'x9' ] );

		$this->assertNull( Status_Fixture_Node::read_status( 'fx', 3 ) );
	}

	public function test_an_absent_key_reads_null(): void {
		$this->assertNull( Status_Fixture_Node::read_status( 'fx', 3 ) );
	}

	public function test_outside_a_worker_publishes_nothing(): void {
		unset( Core::$var['partition'] );

		self::fixture()->publish( [ 'a' => 'x9' ] );

		$this->assertSame( [], $this->memd->sets );
	}
}
