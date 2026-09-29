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
		$this->assertSame( [ 4417 => 'kea' ], $client->scan( 'lab-7:kea', '44', 37 ) );
	}

	public function test_an_unnamed_asker_cannot_ask(): void {
		$anon         = new Table_Asker_Fixture_Node();
		$anon->client = new Table_Client( $anon );
		$anon->sink( $this->asker->sink() );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Table_Client: an unnamed asker cannot ask lab-7:kea' );
		$anon->client->set_multi( 'lab-7:kea', [ 'sku-41' => [ 'a' ] ] );
	}

	public function test_scan_answers_the_keys_under_a_prefix_in_key_order(): void {
		$client = $this->asker->client;
		$client->set_multi( 'lab-7:kea', [ 'sku-43' => [ 'c' ], 'sku-41' => [ 'a' ], 'rid-7' => [ 'r' ] ] );
		$this->assertSame( [ 'sku-41' => 'a', 'sku-43' => 'c' ], $client->scan( 'lab-7:kea', 'sku-', 37, $failed ) );
		$this->assertFalse( $failed );
	}

	public function test_a_scan_prefix_holding_whitespace_fails_unasked(): void {
		$this->assertSame( [], $this->asker->client->scan( 'lab-7:gone.p3', 'sku 4', 37, $failed ) );
		$this->assertTrue( $failed );
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
	}
}
