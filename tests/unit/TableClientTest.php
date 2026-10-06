<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Table_Client;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/** An asker that hands every message to its client first, and keeps the rest. */
final class Table_Asker_Fixture_Node extends Node {
	public Table_Client $client;
	/** @var list<array<int,mixed>> */
	public array $folded = [];
	public ?\Closure $on_message = null;

	public function fill( array $message ): void {
		if ( null !== $this->on_message ) {
			( $this->on_message )( $message );
		}
		if ( ! $this->client->accepts( $message ) ) {
			$this->folded[] = $message;
		}
	}
}

/** A Table that answers every request with one scripted set message and a count of 1. */
final class Scripted_Member_Table_Fixture_Node extends Node {
	public int $type    = Message::TM_STRUCT;
	public mixed $value = null;

	public function fill( array $message ): void {
		foreach ( [ [ $this->type, $this->value ], [ Message::TM_INFO, "SMEMBERS 1\n" ] ] as [ $type, $value ] ) {
			$reply                   = Message::new_message();
			$reply[ Message::TYPE ]  = $type;
			$reply[ Message::FROM ]  = $this->name;
			$reply[ Message::TO ]    = $message[ Message::FROM ];
			$reply[ Message::KEY ]   = Message::TM_INFO === $type ? '' : 'word:kea';
			$reply[ Message::VALUE ] = $value;
			$this->require_sink()->fill( $reply );
		}
	}
}

/**
 * Table_Client: the asking half of the Table protocol, driven through a real
 * Router, interpreter and SQLite-backed Tables.
 */
#[CoversClass( Table_Client::class )]
final class TableClientTest extends TestCase {
	private string $dir = '';
	private Table_Asker_Fixture_Node $asker;

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'table-client-' );
		$this->use_base_dir( $this->dir );
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		$ci = new Command_Interpreter_Node();
		$ci->name( Node_Names::COMMAND_INTERPRETER );
		$ci->sink( $router );
		// Built as a worker's make_node builds them: a mount serves reads only.
		Core::$var['partition'] = '3';
		try {
			foreach ( [ 'lab-7:kea', 'lab-7:owl' ] as $table ) {
				$node = new Table_Node();
				$node->name( $table );
				$node->arguments( [ "{$table}:p3", '777', 'sqlite' ] );
				$node->sink( $ci );
			}
		} finally {
			unset( Core::$var['partition'] );
		}
		$this->asker = new Table_Asker_Fixture_Node();
		$this->asker->name( 'asker-9' );
		$this->asker->sink( $ci );
		$this->asker->client = new Table_Client( $this->asker, [ 'lab-7:kea', 'lab-7:owl' ] );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	public function test_a_round_trip_through_the_graph(): void {
		$client = $this->asker->client;
		$this->assertSame( [ 'sku-41', 'sku-43' ], $client->set_multi( 'lab-7:kea', [ 'sku-41' => [ [ 'usd' => 1250 ] ], 'sku-43' => [ 'b', 37 ] ] ) );
		$this->assertSame( [ 'sku-41' => [ 'usd' => 1250 ], 'sku-43' => 'b' ], $client->get_multi( 'lab-7:kea', [ 'sku-41', 'sku-42', 'sku-43' ], $failed ) );
		$this->assertFalse( $failed );
		$this->assertSame( [ 'sku-44' ], $client->add_multi( 'lab-7:kea', [ 'sku-41' => [ 'x' ], 'sku-44' => [ 'y' ] ] ) );
		$this->assertSame( [ 'sku-41' ], $client->touch( 'lab-7:kea', 900, [ 'sku-41', 'sku-49' ] ) );
		$this->assertSame( [ 'sku-44' ], $client->remove( 'lab-7:kea', [ 'sku-44' ] ) );
		$this->assertSame( [], $this->asker->folded, 'every reply went to the client' );
	}

	public function test_members_round_trip_through_the_graph(): void {
		$client = $this->asker->client;
		$this->assertSame( [ 'word:kea', 'word:owl' ], $client->add_members( 'lab-7:kea', [ 'word:kea' => [ 'u-41' => [ 'hits' => 3 ], 'u-43' => 'weka' ], 'word:owl' => [ 'u-47' => 7 ] ], 37 ) );
		$this->assertSame(
			[
				'word:owl' => [ 'u-47' => 7 ],
				'word:kea' => null,
			],
			$client->members( 'lab-7:kea', [ 'word:owl', 'word:emu', 'word:kea' ], 1, $failed ),
			'a set past its limit reads null, and an absent one is absent'
		);
		$this->assertFalse( $failed );
		$this->assertSame( [ 'word:kea' => [ 'u-41' => [ 'hits' => 3 ], 'u-43' => 'weka' ] ], $client->members( 'lab-7:kea', [ 'word:kea' ], 2, $failed ) );
		$this->assertFalse( $failed );
		$this->assertSame( [], $this->asker->folded, 'every reply went to the client' );
	}

	public function test_a_whole_set_reads_page_by_page_every_member_once_in_order(): void {
		$members = [];
		for ( $i = 0; $i < 25003; ++$i ) {
			$members[ "u-{$i}" ] = $i;
		}
		$this->assertSame( [ 'word:kea' ], $this->asker->client->add_members( 'lab-7:kea', [ 'word:kea' => $members ], 777 ) );
		$asked                   = [];
		$this->asker->on_message = static function ( array $message ) use ( &$asked ): void {
			if ( 0 !== ( $message[ Message::TYPE ] & Message::TM_INFO ) ) {
				$asked[] = $message[ Message::VALUE ];
			}
		};
		$read = $this->asker->client->all_members( 'lab-7:kea', 'word:kea', 10000, $failed );
		$this->assertFalse( $failed );
		$expected = \array_keys( $members );
		\sort( $expected, \SORT_STRING );
		$this->assertSame( [ "SSCAN 1 after={$expected[9999]}\n", "SSCAN 1 after={$expected[19999]}\n", "SSCAN 1\n" ], $asked, 'three pages of up to 10,000' );
		$this->assertSame( $expected, \array_keys( $read ), 'all 25,003, once each, in member order' );
		$this->assertSame( 24999, $read['u-24999'] );
		$this->assertSame( [], $this->asker->folded, 'every reply went to the client' );
	}

	public function test_a_whole_set_read_keeps_an_all_digit_member_and_an_empty_set(): void {
		$client = $this->asker->client;
		$client->add_members( 'lab-7:kea', [ 'word:kea' => [ '0418' => 'kea', '4419' => 'owl', 'u-3' => 3 ] ], 777 );
		$this->assertSame( [ '0418' => 'kea', 4419 => 'owl', 'u-3' => 3 ], $client->all_members( 'lab-7:kea', 'word:kea', 1, $failed ) );
		$this->assertFalse( $failed );
		$this->assertSame( [], $client->all_members( 'lab-7:kea', 'word:emu', 1, $failed ) );
		$this->assertFalse( $failed );
	}

	public function test_a_whole_set_read_fails_whole_when_a_page_is_refused(): void {
		$client = $this->asker->client;
		$client->add_members( 'lab-7:kea', [ 'word:kea' => [ 'u-1' => 1, 'u-2' => 2 ] ], 777 );
		$this->assertSame( [], $client->all_members( 'lab-7:kea', 'word:kea', 10001, $failed ), 'a page past the ceiling is refused' );
		$this->assertTrue( $failed );
		( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->exec( 'DROP TABLE members' );
		$this->assertSame( [], $client->all_members( 'lab-7:kea', 'word:kea', 1, $failed ) );
		$this->assertTrue( $failed );
	}

	public function test_a_whole_set_read_of_an_unnameable_set_asks_nothing(): void {
		$asked                   = 0;
		$this->asker->on_message = static function () use ( &$asked ): void {
			++$asked;
		};
		$this->assertSame( [], $this->asker->client->all_members( 'lab-7:kea', 'word kea', 9, $failed ) );
		$this->assertFalse( $failed );
		$this->assertSame( 0, $asked );
	}

	public function test_members_move_between_sets_through_the_graph(): void {
		$client = $this->asker->client;
		$client->add_members( 'lab-7:kea', [ 'pend-3307' => [ 'x-2' => 1, 'x-1' => 1, 'x-3' => 1 ] ], 900 );
		$this->assertSame( [ 'x-1', 'x-2' ], $client->move_members( 'lab-7:kea', 'pend-3307', 'fly-3307', 2, $failed ) );
		$this->assertFalse( $failed );
		$this->assertSame( [ 'x-2' ], $client->remove_members( 'lab-7:kea', 'fly-3307', [ 'x-2', 'x-8' ] ) );
		$this->assertSame( [ 'pend-3307' => [ 'x-3' => 1 ], 'fly-3307' => [ 'x-1' => 1 ] ], $client->members( 'lab-7:kea', [ 'pend-3307', 'fly-3307' ], 10 ) );
		$this->assertSame( [], $this->asker->folded, 'every reply went to the client' );
	}

	public function test_a_move_from_an_empty_set_answers_nothing_and_does_not_fail(): void {
		$failed = null;
		$this->assertSame( [], $this->asker->client->move_members( 'lab-7:kea', 'void-5521', 'fly-5521', 3, $failed ) );
		$this->assertFalse( $failed );
	}

	public function test_a_move_the_table_refuses_fails(): void {
		$this->assertSame( [], $this->asker->client->move_members( 'lab-7:kea', 'pend-3307', 'fly-3307', 0, $failed ) );
		$this->assertTrue( $failed, 'a count below 1 is refused, never read as empty' );
	}

	public function test_a_move_naming_an_unnameable_set_is_never_asked(): void {
		$client = $this->asker->client;
		$client->add_members( 'lab-7:kea', [ 'pend-3307' => [ 'x-1' => 1 ] ], 900 );
		foreach ( [ [ 'pend-3307', 'fly 3307' ], [ 'pend 3307', 'fly-3307' ], [ '', 'fly-3307' ] ] as [ $from, $to ] ) {
			$failed = null;
			$this->assertSame( [], $client->move_members( 'lab-7:kea', $from, $to, 2, $failed ) );
			$this->assertFalse( $failed, 'a refused ask is not a failed one' );
		}
		$this->assertSame( [ 'pend-3307' => [ 'x-1' => 1 ] ], $client->members( 'lab-7:kea', [ 'pend-3307' ], 9 ), 'nothing moved' );
	}

	public function test_a_move_naming_one_set_twice_is_refused_by_the_table(): void {
		$client = $this->asker->client;
		$client->add_members( 'lab-7:kea', [ 'pend-3307' => [ 'x-1' => 1 ] ], 900 );

		$this->assertSame( [], $client->move_members( 'lab-7:kea', 'pend-3307', 'pend-3307', 2, $failed ) );

		$this->assertTrue( $failed, 'the Table refuses it' );
		$this->assertSame( [ 'pend-3307' => [ 'x-1' => 1 ] ], $client->members( 'lab-7:kea', [ 'pend-3307' ], 9 ) );
	}

	public function test_members_expire_on_the_ttl_the_add_named(): void {
		$client      = $this->asker->client;
		Core::$clock = static fn (): float => 1790000000.0;
		$client->add_members( 'lab-7:kea', [ 'word:kea' => [ 'u-41' => 1 ] ], 37 );
		Core::$clock = static fn (): float => 1790000037.0;
		$this->assertSame( [], $client->members( 'lab-7:kea', [ 'word:kea' ], 9, $failed ) );
		$this->assertFalse( $failed, 'an expired set is absent, not a failed read' );
	}

	public function test_a_refused_member_read_fails_and_a_refused_add_lands_nothing(): void {
		$this->assertSame( [], $this->asker->client->members( 'lab-7:kea', [ 'word:kea' ], 0, $failed ) );
		$this->assertTrue( $failed, 'a limit below 1 is refused, never read as empty' );
		$this->assertSame( [], $this->asker->client->add_members( 'lab-7:kea', [ 'word:kea' => [ 'u-41' => 1 ] ], 0 ) );
		$this->asker->client->members( 'lab-7:gone.p3', [ 'word:kea' ], 9, $failed );
		$this->assertTrue( $failed );
	}

	public function test_a_member_message_that_is_no_struct_pair_fails_the_read(): void {
		$liar = new Scripted_Member_Table_Fixture_Node();
		$liar->name( 'lab-7:liar.p3' );
		$liar->sink( $this->asker->sink() );
		$malformed = [
			[ Message::TM_BYTESTREAM, 'u-41' ],
			[ Message::TM_BYTESTREAM, "OVER 8\n" ],
			[ Message::TM_STRUCT, "OVER 9\n" ],
			[ Message::TM_STRUCT, [ 'u-41', 1 ] ],
			[ Message::TM_STRUCT, [ [ 'u-41' ] ] ],
			[ Message::TM_STRUCT, [ [ 'u-41', 1, 'extra' ] ] ],
			[ Message::TM_STRUCT, [ [ 'm' => 'u-41', 'v' => 1 ] ] ],
			[ Message::TM_STRUCT, [ 'w' => [ 'u-41', 1 ] ] ],
		];
		foreach ( $malformed as [ $type, $value ] ) {
			$liar->type  = $type;
			$liar->value = $value;
			$this->assertSame( [], $this->asker->client->members( 'lab-7:liar.p3', [ 'word:kea' ], 9, $failed ) );
			$this->assertTrue( $failed, 'a malformed set message is a failed read, never a phantom member' );
		}
		$liar->type  = Message::TM_STRUCT;
		$liar->value = [ [ 'u-41', [ 'hits' => 3 ] ], [ '0418', 'owl' ] ];
		$this->assertSame( [ 'word:kea' => [ 'u-41' => [ 'hits' => 3 ], '0418' => 'owl' ] ], $this->asker->client->members( 'lab-7:liar.p3', [ 'word:kea' ], 9, $failed ) );
		$this->assertFalse( $failed );
		$liar->type  = Message::TM_BYTESTREAM;
		$liar->value = "OVER 9\n";
		$this->assertSame( [ 'word:kea' => null ], $this->asker->client->members( 'lab-7:liar.p3', [ 'word:kea' ], 9, $failed ), 'the marker naming the asked limit reads null' );
		$this->assertFalse( $failed );
	}

	public function test_an_all_digit_member_comes_back_as_an_int_key_in_a_member_map(): void {
		$client = $this->asker->client;
		$client->add_members( 'lab-7:kea', [ '4417' => [ '0418' => 'kea', '4419' => 'owl' ] ], 777 );
		$this->assertSame( [ 4417 => [ '0418' => 'kea', 4419 => 'owl' ] ], $client->members( 'lab-7:kea', [ '4417' ], 9 ) );
	}

	public function test_a_member_read_of_no_nameable_set_asks_nothing(): void {
		$this->assertSame( [], $this->asker->client->members( 'lab-7:mute.p3', [ 'word kea' ], 9, $failed ) );
		$this->assertFalse( $failed );
		$this->assertSame( [], $this->asker->client->add_members( 'lab-7:mute.p3', [], 777 ) );
	}

	public function test_all_digit_keys_come_back_as_strings_in_a_key_list(): void {
		$client = $this->asker->client;
		$this->assertSame( [ '4417', '0418' ], $client->set_multi( 'lab-7:kea', [ '4417' => [ 'kea' ], '0418' => [ 'owl' ] ] ) );
		$this->assertSame( [ '4417' ], $client->touch( 'lab-7:kea', 900, [ '4417', '4417' ] ) );
		$this->assertSame( [ '4417' ], $client->remove( 'lab-7:kea', [ '4417' ] ) );
	}

	public function test_an_all_digit_key_comes_back_as_an_int_key_in_a_value_map(): void {
		$client = $this->asker->client;
		$client->set_multi( 'lab-7:kea', [ '4417' => [ 'kea' ], '0418' => [ 'owl' ] ] );
		$read = $client->get_multi( 'lab-7:kea', [ '4417', '0418' ] );
		\ksort( $read, \SORT_STRING );
		$this->assertSame( [ '0418' => 'owl', 4417 => 'kea' ], $read );
	}

	public function test_an_unnamed_asker_cannot_ask(): void {
		$anon         = new Table_Asker_Fixture_Node();
		$anon->client = new Table_Client( $anon );
		$anon->sink( $this->asker->sink() );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Table_Client: an unnamed asker cannot ask lab-7:kea' );
		$anon->client->set_multi( 'lab-7:kea', [ 'sku-41' => [ 'a' ] ] );
	}

	public function test_a_worker_table_keeps_its_production_file_name(): void {
		$this->assertFileExists( $this->dir . '/tables/lab-7:kea.p3.sqlite' );
		$this->assertFileExists( $this->dir . '/tables/lab-7:owl.p3.sqlite' );
	}

	public function test_a_table_no_one_mounted_reads_as_a_failed_read(): void {
		$this->asker->client->get_multi( 'lab-7:gone.p3', [ 'sku-41' ], $failed );
		$this->assertTrue( $failed, 'NOT_AVAILABLE is a failure, never an absence' );
	}

	public function test_a_read_nothing_answers_is_a_failed_read_and_a_write_lands_nothing(): void {
		$mute = new Capture_Sink_Node();
		$mute->name( 'lab-7:mute.p3' );
		$this->assertSame( [], $this->asker->client->get_multi( 'lab-7:mute.p3', [ 'sku-41' ], $failed ) );
		$this->assertTrue( $failed, 'no count is no answer' );
		$this->assertSame( [], $this->asker->client->set_multi( 'lab-7:mute.p3', [ 'sku-41' => [ 'a' ] ] ) );
	}

	public function test_an_exchange_closes_when_the_send_returns_unanswered(): void {
		$mute = new Capture_Sink_Node();
		$mute->name( 'lab-7:mute.p3' );
		$this->asker->client->set_multi( 'lab-7:kea', [ 'sku-41' => [ 'kea' ] ] );
		$this->asker->client->get_multi( 'lab-7:mute.p3', [ 'sku-41' ], $failed );
		$this->assertTrue( $failed );
		$this->assertSame( [ 'sku-41' => 'kea' ], $this->asker->client->get_multi( 'lab-7:kea', [ 'sku-41' ], $failed ), 'the next ask is not refused as in flight' );
		$this->assertFalse( $failed );
	}

	public function test_a_refusal_fails_the_exchange_and_its_text_is_logged(): void {
		$lines = [];
		Core::set_stderr_handler(
			static function ( string $line ) use ( &$lines ): void {
				$lines[] = $line;
			}
		);
		$this->assertSame( [], $this->asker->client->set_multi( 'lab-7:gone.p3', [ 'sku-41' => [ 'a', 37 ] ] ) );
		$this->assertSame( [], $this->asker->client->get_multi( 'lab-7:lost.p3', [ 'sku-41' ], $failed ) );
		$this->assertTrue( $failed );
		$log = \implode( "\n", $lines );
		$this->assertStringContainsString( 'Table_Client: lab-7:gone.p3 refused an ask from asker-9 — NOT_AVAILABLE', $log );
		$this->assertStringContainsString( 'Table_Client: lab-7:lost.p3 refused an ask from asker-9 — NOT_AVAILABLE', $log );
	}

	public function test_an_asker_with_no_sink_cannot_ask(): void {
		$lone = new Table_Asker_Fixture_Node();
		$lone->name( 'asker-11' );
		$lone->client = new Table_Client( $lone );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Table_Client: asker-11 has no sink' );
		$lone->client->get_multi( 'lab-7:kea', [ 'sku-41' ] );
	}

	public function test_an_ask_while_another_is_in_flight_is_refused(): void {
		$this->asker->client->set_multi( 'lab-7:kea', [ 'sku-41' => [ 'a' ] ] );
		$this->asker->on_message = function (): void {
			$this->asker->on_message = null;
			$this->asker->client->get_multi( 'lab-7:owl', [ 'sku-42' ] );
		};
		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'Table_Client: asker-9 asked lab-7:owl while an ask of lab-7:kea was in flight' );
		$this->asker->client->get_multi( 'lab-7:kea', [ 'sku-41' ] );
	}

	public function test_a_refused_ask_leaves_the_client_free_to_ask_again(): void {
		$this->asker->client->set_multi( 'lab-7:kea', [ 'sku-41' => [ 'a' ] ] );
		$this->asker->on_message = function (): void {
			$this->asker->on_message = null;
			$this->asker->client->get_multi( 'lab-7:owl', [ 'sku-42' ] );
		};
		try {
			$this->asker->client->get_multi( 'lab-7:kea', [ 'sku-41' ] );
			$this->fail( 'the nested ask was not refused' );
		} catch ( \LogicException ) {
			$this->assertSame( [ 'sku-41' => 'a' ], $this->asker->client->get_multi( 'lab-7:kea', [ 'sku-41' ] ) );
		}
	}

	public function test_a_reply_from_a_table_no_ask_awaits_is_dropped_not_folded(): void {
		$stray                   = Message::new_message();
		$stray[ Message::TYPE ]  = Message::TM_STRUCT;
		$stray[ Message::FROM ]  = 'lab-7:owl';
		$stray[ Message::KEY ]   = 'sku-41';
		$stray[ Message::VALUE ] = [ 'rid' => 'r-0412' ];
		$lines = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$lines ): void {
				$lines[] = $line;
			}
		);
		$this->asker->fill( $stray );
		$this->asker->fill( $stray );
		$this->assertSame( [], $this->asker->folded );
		$this->assertCount( 1, $lines, 'the drop line is rate-limited' );
		$this->assertStringContainsString( 'Table_Client: dropped a reply no ask awaits — lab-7:owl to asker-9', $lines[0] );
	}

	public function test_a_table_first_named_by_an_ask_is_never_folded_afterwards(): void {
		$this->asker->client->get_multi( 'lab-7:gone.p3', [ 'sku-41' ] );
		$late                   = Message::new_message();
		$late[ Message::TYPE ]  = Message::TM_INFO;
		$late[ Message::FROM ]  = 'lab-7:gone.p3';
		$late[ Message::VALUE ] = "MGET 0\n";
		$this->asker->fill( $late );
		$this->assertSame( [], $this->asker->folded );
	}

	public function test_a_message_from_anything_but_a_table_is_the_askers_input(): void {
		$input                   = Message::new_message();
		$input[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$input[ Message::FROM ]  = 'peer-5';
		$input[ Message::VALUE ] = "r-0412\n";
		$this->asker->fill( $input );
		$this->assertSame( [ 'peer-5' ], \array_column( $this->asker->folded, Message::FROM ) );
	}

	public function test_while_one_table_is_awaited_another_tables_reply_is_not_collected(): void {
		$this->asker->client->set_multi( 'lab-7:kea', [ 'sku-41' => [ 'kea' ] ] );
		$this->asker->on_message = function ( array $message ): void {
			if ( 'lab-7:kea' !== $message[ Message::FROM ] ) {
				return;
			}
			$this->asker->on_message = null;
			$stray                   = Message::new_message();
			$stray[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$stray[ Message::FROM ]  = 'lab-7:owl';
			$stray[ Message::KEY ]   = 'sku-49';
			$stray[ Message::VALUE ] = 'owl';
			$this->asker->fill( $stray );
		};
		$this->assertSame( [ 'sku-41' => 'kea' ], $this->asker->client->get_multi( 'lab-7:kea', [ 'sku-41' ], $failed ) );
		$this->assertFalse( $failed );
		$this->assertSame( [], $this->asker->folded );
	}

	public function test_a_key_holding_whitespace_is_never_asked(): void {
		$this->assertSame( [], $this->asker->client->get_multi( 'lab-7:kea', [ 'sku 41' ], $failed ) );
		$this->assertFalse( $failed );
		$this->assertSame( [], $this->asker->client->remove( 'lab-7:kea', [ "sku-41\t" ] ) );
		$this->asker->client->add_members( 'lab-7:kea', [ 'pend' => [ 'x-1' => 1 ] ], 900 );
		$this->assertSame( [], $this->asker->client->remove_members( 'lab-7:kea', 'pend 3307', [ 'x-1' ] ), 'a set key holding whitespace would split into the set pend and members' );
		$this->assertSame( [ 'pend' => [ 'x-1' => 1 ] ], $this->asker->client->members( 'lab-7:kea', [ 'pend' ], 9 ) );
	}
}
