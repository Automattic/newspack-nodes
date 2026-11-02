<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Frontier;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Table_Client;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/** An owner that hands every message to its client first, and counts its asks. */
final class Frontier_Owner_Fixture_Node extends Node {
	public Table_Client $client;
	public int $replies = 0;

	public function fill( array $message ): void {
		if ( $this->client->accepts( $message ) ) {
			++$this->replies;
		}
	}
}

/**
 * Frontier: a work set in one SQLite Table, asked through a real Router
 * and interpreter, or in the process.
 */
#[CoversClass( Frontier::class )]
final class FrontierTest extends TestCase {
	private const TABLE = 'lab-9:front';

	private string $dir = '';
	private Frontier_Owner_Fixture_Node $owner;

	/** The Table name the frontier under test asks; a test may move it. */
	private string $table = self::TABLE;

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'frontier-' );
		$this->use_base_dir( $this->dir );
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		$ci = new Command_Interpreter_Node();
		$ci->name( Node_Names::COMMAND_INTERPRETER );
		$ci->sink( $router );
		Core::$var['partition'] = '3';
		try {
			$node = new Table_Node();
			$node->name( self::TABLE );
			$node->arguments( [ self::TABLE . ':p3', '777', 'sqlite' ] );
			$node->sink( $ci );
		} finally {
			unset( Core::$var['partition'] );
		}
		$this->owner = new Frontier_Owner_Fixture_Node();
		$this->owner->name( 'owner-41' );
		$this->owner->sink( $ci );
		$this->owner->client = new Table_Client( $this->owner );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	/** A frontier as a new process builds it, asking whichever Table `$this->table` names. */
	private function frontier(): Frontier {
		return new Frontier( $this->owner->client, fn (): string => $this->table );
	}

	private function front(): Table_Node {
		$table = Core::node( self::TABLE );
		\assert( $table instanceof Table_Node );
		return $table;
	}

	/** @return array<array-key,mixed> Both sets, as the Table holds them. */
	private function sets(): array {
		return $this->front()->members_of( [ Frontier::PENDING, Frontier::INFLIGHT ], 50 ) ?? [];
	}

	public function test_added_members_are_taken_lowest_first_with_their_values_into_inflight(): void {
		$frontier = $this->frontier();
		$this->assertTrue( $frontier->add( [ 'subj-c' => [ 'https://feed-3.example/c', null, 2 ], 'subj-a' => 'hop-a-7', 'subj-b' => 11 ] ) );

		$this->assertSame( [ [ 'subj-a', 'hop-a-7' ], [ 'subj-b', 11 ] ], $frontier->take( 2 ) );

		$this->assertSame(
			[
				Frontier::PENDING  => [ 'subj-c' => [ 'https://feed-3.example/c', null, 2 ] ],
				Frontier::INFLIGHT => [
					'subj-a' => 'hop-a-7',
					'subj-b' => 11,
				],
			],
			$this->sets()
		);
	}

	public function test_a_take_of_no_members_asks_nothing(): void {
		$frontier = $this->frontier();
		$frontier->add( [ 'subj-a' => 1 ] );
		$frontier->take( 1 );
		$asked = $this->owner->replies;

		$this->assertSame( [], $frontier->take( 0 ) );
		$this->assertSame( $asked, $this->owner->replies );
	}

	public function test_a_settled_member_leaves_inflight(): void {
		$frontier = $this->frontier();
		$frontier->add( [ 'subj-a' => 1, 'subj-b' => 2 ] );
		$frontier->take( 2 );

		$frontier->settle( [ 'subj-b' ] );
		$frontier->take( 0 );

		$this->assertSame( [ Frontier::INFLIGHT => [ 'subj-a' => 1 ] ], $this->sets() );
	}

	public function test_a_new_process_returns_what_the_last_left_in_flight_before_its_first_take(): void {
		$crashed = $this->frontier();
		$crashed->add( [ 'subj-a' => 'kea-1', 'subj-b' => 'kea-2', 'subj-c' => 'kea-3' ] );
		$crashed->take( 2 );

		$this->assertSame( [ [ 'subj-a', 'kea-1' ], [ 'subj-b', 'kea-2' ], [ 'subj-c', 'kea-3' ] ], $this->frontier()->take( 5 ) );
	}

	public function test_restart_owes_a_recovery_before_the_next_take(): void {
		$frontier = $this->frontier();
		$frontier->add( [ 'subj-a' => 1, 'subj-b' => 2 ] );
		$frontier->take( 1 );
		$this->assertSame( [ [ 'subj-b', 2 ] ], $frontier->take( 1 ), 'a live process does not recover twice' );
		$frontier->settle( [ 'subj-b' ] );

		$frontier->restart();

		$this->assertSame( [ [ 'subj-a', 1 ] ], $frontier->take( 4 ) );
	}

	public function test_once_a_take_comes_up_short_the_next_asks_nothing_until_an_add(): void {
		$frontier = $this->frontier();
		$frontier->add( [ 'subj-a' => 1 ] );
		$this->assertSame( [ [ 'subj-a', 1 ] ], $frontier->take( 3 ) );
		$this->front()->add_members( [ Frontier::PENDING => [ [ 'subj-z' => 26 ], 900 ] ] );
		$asked = $this->owner->replies;

		$this->assertSame( [], $frontier->take( 3 ), 'pending is known empty' );
		$this->assertSame( $asked, $this->owner->replies, 'and the Table is not asked' );

		$frontier->add( [ 'subj-b' => 2 ] );
		$this->assertSame( [ [ 'subj-b', 2 ], [ 'subj-z', 26 ] ], $frontier->take( 3 ) );
	}

	public function test_an_add_the_table_refuses_answers_false(): void {
		$this->table = 'lab-9:gone.p3';

		$this->assertFalse( $this->frontier()->add( [ 'subj-a' => 1 ] ) );
	}

	public function test_a_recovery_the_table_does_not_answer_moves_nothing_and_is_asked_again(): void {
		$this->frontier()->add( [ 'subj-a' => 'kea-1' ] );
		$this->frontier()->take( 1 );
		$mute = new Capture_Sink_Node();
		$mute->name( 'lab-9:mute.p3' );
		$this->table = 'lab-9:mute.p3';
		$frontier    = $this->frontier();

		$this->assertSame( [], $frontier->take( 2 ) );

		$this->table = self::TABLE;
		$this->assertSame( [ [ 'subj-a', 'kea-1' ] ], $frontier->take( 2 ), 'the name is read at each ask, and the recovery is still owed' );
	}

	public function test_a_member_waits_member_ttl_whatever_the_tables_own(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$this->frontier()->add( [ 'subj-a' => 1 ] );

		Core::$clock = static fn (): float => 1790000000.0 + Frontier::MEMBER_TTL - 1;
		$this->assertSame( [ Frontier::PENDING => [ 'subj-a' => 1 ] ], $this->sets() );
		Core::$clock = static fn (): float => 1790000000.0 + Frontier::MEMBER_TTL;
		$this->assertSame( [], $this->sets() );
		$this->assertSame( 31536000, Frontier::MEMBER_TTL );
	}

	public function test_settled_members_leave_inflight_at_the_next_take_together(): void {
		$frontier = $this->frontier();
		$frontier->add( [ 'subj-a' => 1, 'subj-b' => 2, 'subj-c' => 3 ] );
		$frontier->take( 3 );

		$frontier->settle( [ 'subj-a' ] );
		$frontier->settle( [ 'subj-c' ] );
		$this->assertSame( [ Frontier::INFLIGHT => [ 'subj-a' => 1, 'subj-b' => 2, 'subj-c' => 3 ] ], $this->sets(), 'a settle asks nothing' );

		$this->assertSame( [], $frontier->take( 0 ) );
		$this->assertSame( [ Frontier::INFLIGHT => [ 'subj-b' => 2 ] ], $this->sets() );
	}

	public function test_restart_removes_what_was_settled_before_it_recovers(): void {
		$frontier = $this->frontier();
		$frontier->add( [ 'subj-a' => 'kea-1', 'subj-b' => 'kea-2' ] );
		$frontier->take( 2 );
		$frontier->settle( [ 'subj-a' ] );

		$frontier->restart();

		$this->assertSame( [ Frontier::INFLIGHT => [ 'subj-b' => 'kea-2' ] ], $this->sets() );
		$this->assertSame( [ [ 'subj-b', 'kea-2' ] ], $frontier->take( 5 ) );
	}

	public function test_drain_empties_both_sets_and_returns_their_members(): void {
		$crashed = $this->frontier();
		$crashed->add( [ 'subj-d' => 4, 'subj-e' => 5 ] );
		$crashed->take( 1 );
		$frontier = $this->frontier();
		$frontier->add( [ 'subj-f' => 6, 'subj-g' => 7 ] );
		$frontier->take( 1 );
		$frontier->settle( [ 'subj-d' ] );

		$drained = $frontier->drain();

		\sort( $drained );
		$this->assertSame( [ 'subj-e', 'subj-f', 'subj-g' ], $drained );
		$this->assertSame( [], $this->sets() );
		$this->assertSame( [], $frontier->take( 4 ) );
	}

	public function test_drain_pages_past_one_take(): void {
		$members = [];
		for ( $i = 0; $i <= Table_Node::MAX_MEMBERS_LIMIT; $i++ ) {
			$members[ "subj-{$i}" ] = $i;
		}
		$frontier = $this->frontier();
		$frontier->add( $members );

		$this->assertCount( Table_Node::MAX_MEMBERS_LIMIT + 1, $frontier->drain() );
		$this->assertSame( [], $this->sets() );
	}

	public function test_an_idle_drain_asks_nothing(): void {
		$frontier = $this->frontier();
		$frontier->add( [ 'subj-a' => 1 ] );
		$frontier->drain();
		$asked = $this->owner->replies;

		$this->assertSame( [], $frontier->drain() );
		$this->assertSame( $asked, $this->owner->replies );
	}

	public function test_a_frontier_with_no_table_keeps_both_sets_in_the_process_in_the_order_added(): void {
		$frontier = new Frontier();
		$this->assertTrue( $frontier->add( [ 'subj-c' => 'gull-3', 'subj-a' => 'gull-1', 'subj-b' => 'gull-2' ] ) );

		$this->assertSame( [ [ 'subj-c', 'gull-3' ], [ 'subj-a', 'gull-1' ] ], $frontier->take( 2 ) );
		$frontier->settle( [ 'subj-c' ] );
		$frontier->restart();
		$this->assertSame( [ [ 'subj-b', 'gull-2' ], [ 'subj-a', 'gull-1' ] ], $frontier->take( 5 ), 'a restart returns what is in flight' );
		$frontier->add( [ 'subj-h' => 'gull-8' ] );

		$drained = $frontier->drain();

		\sort( $drained );
		$this->assertSame( [ 'subj-a', 'subj-b', 'subj-h' ], $drained );
		$this->assertSame( [], $frontier->take( 5 ) );
		$this->assertSame( 0, $this->owner->replies, 'no Table is asked' );
	}
}
