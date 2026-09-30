<?php
/**
 * `wp nodes tables list` and `wp nodes tables flush`: every declared Table,
 * partition by partition, every declared Ledger once, plus the command-session
 * store; a live owner is asked over its command channel, a Table no worker
 * owns is written from the CLI only under the fleet hold, and a Ledger no
 * worker declaring it runs is flushed from the CLI itself.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Callback_Node;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Ledger_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Sqlite_Arm;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tables_CLI_Command;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_Base;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Tables_CLI_Command::class )]
#[CoversClass( CLI::class )]
final class TablesCliCommandTest extends TestCase {
	private string $base  = '';
	private string $stock = '';

	/** Every command the fake worker verified and answered, as `<to> <verb>`. */
	private array $answered = [];

	/** Text of an unaddressed broadcast the fake worker writes before each answer; '' writes none. */
	private string $broadcast = '';

	/** The FROM of every command the fake worker read. */
	private array $asked_from = [];

	/** Whether the fake worker follows each answer with one to another session's same receiver. */
	private bool $decoy = false;

	protected function setUp(): void {
		parent::setUp();
		$this->base = $this->make_temp_dir( 'tables-cli-' );
		$this->use_base_dir( $this->base );
		$this->use_wpdb();
		$this->use_loop_time();
		Topology_Registry::reset();
		$this->stock = $this->stock_topology_dir( 'tables-cli-stock-' );
		$this->write_tsl( 'kea-t', "var num_partitions = 2\nmake_node Table lab-7:kea kea:p<partition> 777 sqlite\n" );
		$this->write_tsl( 'owl-w', "make_node Table lab-7:owl owl:p<partition> 37 wpdb\n" );
		\update_option( 'newspack_nodes_topologies', [ 'kea-t', 'owl-w' ] );
		Config::reset();
		foreach ( [ 'lines', 'logs', 'warns', 'errors', 'success', 'tables', 'confirms' ] as $stream ) {
			$GLOBALS[ "_test_wp_cli_{$stream}" ] = [];
		}
		unset( $GLOBALS['_test_wp_cli_confirm'] );
	}

	protected function tearDown(): void {
		unset( $GLOBALS['_test_wp_cli_confirm'] );
		\delete_option( 'newspack_nodes_topologies' );
		Spawn_Coordinator::clear_hold();
		Config::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->base );
		parent::tearDown();
	}

	/** A `sqlite` partition's file, written as its worker writes it. */
	private function seed_kea( int $partition, int $rows ): void {
		$arm = new Sqlite_Arm( Table_Node::file( 'lab-7:kea', $partition ), 'kea:p3' );
		for ( $i = 1; $i <= $rows; ++$i ) {
			$arm->set( "kea:p{$partition}:sku-{$i}", "kea-{$i}", 0 );
		}
		$arm->add_members( [ "kea:p{$partition}:word:kea" => [ [ 'u-41' => 1 ], 900 ] ] );
	}

	/** Rows left in a `sqlite` partition's file, keyed and member. */
	private function rows_in( int $partition ): int {
		$db = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', $partition ) );
		return (int) $db->query( 'SELECT ( SELECT COUNT(*) FROM kv ) + ( SELECT COUNT(*) FROM members )' )->fetchColumn();
	}

	/**
	 * A live `kea-t.p{partition}` holding its `lab-7:kea` Table; see answering().
	 *
	 * @param bool $answers False for a worker that reads commands and answers none.
	 */
	private function live_worker( int $partition, bool $answers = true ): Table_Node {
		Core::$var['partition'] = (string) $partition;
		try {
			$table = new Table_Node();
			$table->name( 'lab-7:kea' );
			$table->arguments( [ "kea:p{$partition}", '777', 'sqlite' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$table->sink( new Capture_Sink_Node() );
		$this->answering( 'kea-t', $partition, $answers );
		return $table;
	}

	/**
	 * A live `{topology}.p{partition}`'s lock dir with a fresh heartbeat, and
	 * the read of its input channel a worker runs, verifying each command and
	 * answering it through the named node's `:config` interpreter onto its
	 * output channel, TO the command's FROM.
	 *
	 * @param bool $answers False for a worker that reads commands and answers none.
	 */
	private function answering( string $topology, int $partition, bool $answers ): void {
		$lock = "{$this->base}/locks/{$topology}.p{$partition}.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", '1' );
		$input  = Worker_Base::ipc_dir( $this->base, $topology, $partition, Worker_Base::IPC_INPUT );
		$output = Worker_Base::ipc_dir( $this->base, $topology, $partition, Worker_Base::IPC_OUTPUT );
		\mkdir( $input, 0755, true );
		\mkdir( $output, 0755, true );
		$replies = new Partition_Node();
		$replies->arguments( Worker_Base::ipc_partition_args( $output ) );
		// A Partition's batch flushes on its timer, which fires only with a sink.
		$replies->sink( new Capture_Sink_Node() );
		$reader = new Consumer_Node();
		$reader->arguments( [ $input ] );
		$reader->next_offset( 'start' );
		$reader->sink(
			new Callback_Node(
				function ( array $command ) use ( $replies, $answers ): void {
					$this->assertTrue( Command_Auth::verify( $command ), 'the CLI signs what it sends a worker' );
					$verb             = Core::as_string( $command[ Message::VALUE ]['name'] );
					$this->answered[] = Core::as_string( $command[ Message::TO ] ) . " {$verb}";
					$this->asked_from[] = Core::as_string( $command[ Message::FROM ] );
					if ( ! $answers ) {
						return;
					}
					if ( '' !== $this->broadcast ) {
						$note                   = Message::new_message();
						$note[ Message::TYPE ]  = Message::TM_INFO;
						$note[ Message::VALUE ] = $this->broadcast;
						$replies->fill( $note );
					}
					$reply                  = Message::new_message();
					$reply[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_RESPONSE;
					$reply[ Message::TO ]   = $command[ Message::FROM ];
					try {
						$payload = ( Core::node( Core::as_string( $command[ Message::TO ] ) ) ?? throw new \RuntimeException( 'NOT_AVAILABLE' ) )->dispatch( $verb, Core::arr( $command[ Message::VALUE ]['arguments'] ?? [] ) );
					} catch ( \RuntimeException $e ) {
						$reply[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_ERROR;
						$payload                = $e->getMessage() . "\n";
					}
					$reply[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => [], 'payload' => $payload ];
					$replies->fill( $reply );
					if ( $this->decoy ) {
						$other                   = $reply;
						$other[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_ERROR;
						$other[ Message::TO ]    = \str_replace( '_cli:' . \getmypid(), '_cli:48211', Core::as_string( $command[ Message::FROM ] ) );
						$other[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => [], 'payload' => "decoy-3318\n" ];
						$replies->fill( $other );
					}
				}
			)
		);
	}

	/** @return list<array<string,mixed>> The rows the last table printed. */
	private function printed(): array {
		return \end( $GLOBALS['_test_wp_cli_tables'] )['items'] ?? [];
	}

	private function command(): Tables_CLI_Command {
		return new Tables_CLI_Command();
	}

	// ── list ──

	public function test_list_names_every_declared_partition_and_the_session_store(): void {
		$this->seed_kea( 0, 3 );
		$file = Table_Node::file( 'lab-7:kea', 0 );
		\clearstatcache();
		$size = \filesize( $file ) + ( \is_file( "{$file}-wal" ) ? \filesize( "{$file}-wal" ) : 0 );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertSame(
			[
				[ 'Table' => 'lab-7:kea', 'Partition' => 0, 'Backend' => 'sqlite', 'TTL' => '777', 'Owner' => 'kea-t.p0', 'State' => 'down', 'Store' => $file, 'Bytes' => $size, 'Verbs' => null ],
				[ 'Table' => 'lab-7:kea', 'Partition' => 1, 'Backend' => 'sqlite', 'TTL' => '777', 'Owner' => 'kea-t.p1', 'State' => 'down', 'Store' => Table_Node::file( 'lab-7:kea', 1 ), 'Bytes' => 0, 'Verbs' => null ],
				[ 'Table' => 'lab-7:owl', 'Partition' => 0, 'Backend' => 'wpdb', 'TTL' => '37', 'Owner' => 'owl-w.p0', 'State' => 'down', 'Store' => 'wp_newspack_nodes_table', 'Bytes' => null, 'Verbs' => null ],
				[ 'Table' => Command_Auth::SESSIONS_TABLE, 'Partition' => 0, 'Backend' => 'wpdb', 'TTL' => '60-86400', 'Owner' => '-', 'State' => '-', 'Store' => 'wp_newspack_nodes_table', 'Bytes' => null, 'Verbs' => null ],
			],
			$this->printed()
		);
		$this->assertSame( 'json', \end( $GLOBALS['_test_wp_cli_tables'] )['format'] );
	}

	/** The session store's row is its declaration: listing it opens nothing, so a store that will not open lists all the same. */
	public function test_list_names_the_session_store_without_opening_it(): void {
		$GLOBALS['wpdb']->deny['CREATE TABLE'] = 'CREATE command denied 1030';

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertSame( [ 'Table' => Command_Auth::SESSIONS_TABLE, 'Partition' => 0, 'Backend' => 'wpdb', 'TTL' => '60-86400', 'Owner' => '-', 'State' => '-', 'Store' => 'wp_newspack_nodes_table', 'Bytes' => null, 'Verbs' => null ], \array_slice( $this->printed(), -1 )[0] );
	}

	public function test_list_counts_a_sqlite_partitions_shm_in_its_bytes(): void {
		$this->seed_kea( 0, 3 );
		$file = Table_Node::file( 'lab-7:kea', 0 );
		\file_put_contents( "{$file}-shm", \str_repeat( 's', 4099 ) );
		\clearstatcache();
		$size = \filesize( $file ) + ( \is_file( "{$file}-wal" ) ? \filesize( "{$file}-wal" ) : 0 ) + 4099;

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertSame( $size, $this->printed()[0]['Bytes'] );
	}

	public function test_list_reads_an_on_demand_owner_with_no_lock_as_idle(): void {
		$this->write_tsl( 'kea-t', "var num_partitions = 2\nvar on_demand_idle = 41\nmake_node Table lab-7:kea kea:p<partition> 777 sqlite\n" );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertSame( [ 'idle', 'idle', 'down' ], \array_column( \array_slice( $this->printed(), 0, 3 ), 'State' ), 'as `wp nodes status` reads them' );
	}

	public function test_list_reads_an_owner_whose_lock_dir_holds_no_heartbeat_past_the_orphan_grace_as_stale(): void {
		\mkdir( "{$this->base}/locks/kea-t.p1.lock.d", 0755, true );
		\touch( "{$this->base}/locks/kea-t.p1.lock.d", \time() - ( \Newspack_Nodes\Lock_Node::ORPHAN_GRACE_S + 43 ) );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertSame( [ 'down', 'stale' ], \array_column( \array_slice( $this->printed(), 0, 2 ), 'State' ), 'as `wp nodes status` reads it' );
	}

	public function test_list_reads_a_live_owners_counters_over_its_command_channel(): void {
		$table = $this->live_worker( 1 );
		$table->store( 'sku-9', 'kea-9' );
		$ask                      = Message::new_message();
		$ask[ Message::TYPE ]     = Message::TM_REQUEST;
		$ask[ Message::FROM ]     = 'asker-9';
		$ask[ Message::VALUE ]    = "MGET sku-9 sku-10\n";
		$table->fill( $ask );
		$table->fill( $ask );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$row = $this->printed()[1];
		$this->assertSame( [ 'lab-7:kea', 1, 'live' ], [ $row['Table'], $row['Partition'], $row['State'] ] );
		$this->assertSame( 2, $row['Verbs']['MGET']['calls'] );
		$this->assertArrayHasKey( 'total_ms', $row['Verbs']['MGET'] );
		$this->assertArrayNotHasKey( 'SADD', $row['Verbs'], 'a verb never called is left out' );
		$this->assertSame( [ 'lab-7:kea:config stats' ], $this->answered, 'one stats asked, of the live owner alone' );
		$this->assertNull( $this->printed()[0]['Verbs'], 'a down owner is asked nothing' );
	}

	public function test_each_ask_is_headed_by_this_process_and_names_the_receiver_and_stem(): void {
		$this->live_worker( 1 );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertSame( [ '_output/_cli:' . \getmypid() . '/tables-cli/' . Table_Node::stem( 'lab-7:kea', 1 ) ], $this->asked_from );
		$this->assertNotNull( $this->printed()[1]['Verbs'], 'the reply is filed under its stem' );
	}

	public function test_another_sessions_reply_to_the_same_stem_is_not_filed(): void {
		$this->decoy = true;
		$table       = $this->live_worker( 1 );
		$table->store( 'sku-9', 'kea-9' );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertIsArray( $this->printed()[1]['Verbs'], 'the decoy error never replaced the counters' );
	}

	public function test_a_worker_broadcast_during_the_ask_is_neither_warned_about_nor_taken_for_a_reply(): void {
		$this->broadcast = 'ember-4471 rolled';
		$this->live_worker( 1 );
		$stderr = '';
		Core::set_stderr_handler( function ( $text ) use ( &$stderr ) { $stderr .= $text; } );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertStringNotContainsString( 'not addressed', $stderr );
		$this->assertNotNull( $this->printed()[1]['Verbs'], 'the addressed reply still lands' );
	}

	public function test_the_wait_ends_when_every_owner_has_answered(): void {
		$this->live_worker( 1 );
		$started = Core::right_now();

		$this->command()->list_( [], [ 'format' => 'json', 'timeout' => '30' ] );

		$this->assertNotNull( $this->printed()[1]['Verbs'] );
		$this->assertLessThan( 5.0, Core::right_now() - $started, 'the last reply ends the wait, not the 30 s timeout' );
	}

	public function test_the_table_format_summarises_counters_and_sizes_in_one_line(): void {
		$table = $this->live_worker( 1 );
		$ask                   = Message::new_message();
		$ask[ Message::TYPE ]  = Message::TM_REQUEST;
		$ask[ Message::FROM ]  = 'asker-9';
		$ask[ Message::VALUE ] = "GET sku-9\n";
		$table->fill( $ask );

		$this->command()->list_( [], [] );

		$row = $this->printed()[1];
		$this->assertSame( 'table', \end( $GLOBALS['_test_wp_cli_tables'] )['format'] );
		$this->assertMatchesRegularExpression( '/^GET 1 [\d.]+ms$/', $row['Verbs'] );
		$this->assertSame( '-', $this->printed()[2]['Bytes'], 'a wpdb Table has no file to size' );
	}

	public function test_an_owner_that_does_not_answer_lists_without_counters_and_says_so(): void {
		$this->live_worker( 1, false );

		$this->command()->list_( [], [ 'format' => 'json', 'timeout' => '3' ] );

		$this->assertNull( $this->printed()[1]['Verbs'] );
		$this->assertSame( [ 'kea-t.p1 did not answer stats for lab-7:kea within 3s' ], $GLOBALS['_test_wp_cli_warns'] );
	}

	public function test_an_owner_that_refuses_stats_lists_without_counters_and_says_why(): void {
		$this->live_worker( 1 );
		Core::node( 'lab-7:kea' )->remove_node();
		$this->answered = [];

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertNull( $this->printed()[1]['Verbs'] );
		$this->assertSame( [ 'kea-t.p1 refused stats for lab-7:kea: NOT_AVAILABLE' ], $GLOBALS['_test_wp_cli_warns'] );
	}

	// ── inactive topologies ──

	/** Registers `emu-z`, a topology no option activates, declaring a `sqlite` Table over two partitions. */
	private function register_inactive_emu(): void {
		$this->write_tsl( 'emu-z', "var num_partitions = 2\nmake_node Table lab-7:emu emu:p<partition> 4242 sqlite\n" );
	}

	/** An `emu` partition's file, written as its worker would write it. */
	private function seed_emu( int $partition, int $rows ): void {
		$arm = new Sqlite_Arm( Table_Node::file( 'lab-7:emu', $partition ), 'emu:p3' );
		for ( $i = 1; $i <= $rows; ++$i ) {
			$arm->set( "emu:p{$partition}:sku-{$i}", "emu-{$i}", 0 );
		}
	}

	private function emu_rows( int $partition ): int {
		$db = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:emu', $partition ) );
		return (int) $db->query( 'SELECT COUNT(*) FROM kv' )->fetchColumn();
	}

	public function test_list_shows_an_inactive_topologys_partitions_with_their_files_and_bytes(): void {
		$this->register_inactive_emu();
		$this->seed_emu( 1, 5 );
		$file = Table_Node::file( 'lab-7:emu', 1 );
		\clearstatcache();
		$size = \filesize( $file ) + ( \is_file( "{$file}-wal" ) ? \filesize( "{$file}-wal" ) : 0 );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$emu = \array_values( \array_filter( $this->printed(), static fn ( array $row ): bool => 'lab-7:emu' === $row['Table'] ) );
		$this->assertSame(
			[
				[ 'Table' => 'lab-7:emu', 'Partition' => 0, 'Backend' => 'sqlite', 'TTL' => '4242', 'Owner' => 'emu-z.p0', 'State' => 'inactive', 'Store' => Table_Node::file( 'lab-7:emu', 0 ), 'Bytes' => 0, 'Verbs' => null ],
				[ 'Table' => 'lab-7:emu', 'Partition' => 1, 'Backend' => 'sqlite', 'TTL' => '4242', 'Owner' => 'emu-z.p1', 'State' => 'inactive', 'Store' => $file, 'Bytes' => $size, 'Verbs' => null ],
			],
			$emu
		);
		$this->assertGreaterThan( 0, $size );
	}

	public function test_flush_empties_an_inactive_topologys_table_without_the_hold(): void {
		$this->register_inactive_emu();
		$this->seed_emu( 0, 4 );
		$this->seed_emu( 1, 6 );

		$this->command()->flush( [ 'lab-7:emu' ], [] );

		$this->assertSame( [ 0, 0 ], [ $this->emu_rows( 0 ), $this->emu_rows( 1 ) ] );
		$this->assertMatchesRegularExpression( '/^lab-7:emu\.p0: [\d.]+[KM]?B released; emu-z is inactive$/', $GLOBALS['_test_wp_cli_logs'][0] );
		$this->assertSame( [ 'Flushed 2 Table partitions.' ], $GLOBALS['_test_wp_cli_success'] );
		$this->assertSame( [], $this->answered, 'no worker was asked' );
	}

	public function test_flush_with_no_table_named_counts_the_inactive_partitions(): void {
		$this->register_inactive_emu();

		$this->caught( fn () => $this->command()->flush( [], [] ), 'every Table was flushed unasked' );

		$this->assertSame( [ 'Flush every row of 5 declared Table partitions? The session store is left alone.' ], $GLOBALS['_test_wp_cli_confirms'] );
	}

	public function test_a_table_an_active_and_an_inactive_topology_both_declare_is_owned_by_the_active_one(): void {
		$this->write_tsl( 'gnu-y', "var num_partitions = 4\nmake_node Table lab-7:kea kea:p<partition> 777 sqlite\n" );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$kea = \array_filter( $this->printed(), static fn ( array $row ): bool => 'lab-7:kea' === $row['Table'] );
		$this->assertSame( [ 'kea-t.p0', 'kea-t.p1', 'gnu-y.p2', 'gnu-y.p3' ], \array_column( \array_values( $kea ), 'Owner' ), 'the active declarer owns what it declares; the inactive one adds only the partitions beyond' );
		$this->assertSame( [ 'down', 'down', 'inactive', 'inactive' ], \array_column( \array_values( $kea ), 'State' ) );
	}

	public function test_an_inactive_topology_that_will_not_read_is_warned_about_and_the_rest_lists(): void {
		$this->write_tsl( 'emu-z', "include no-such-topology\n" );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertCount( 1, $GLOBALS['_test_wp_cli_warns'] );
		$this->assertStringStartsWith( 'emu-z: ', $GLOBALS['_test_wp_cli_warns'][0] );
		$this->assertContains( 'lab-7:kea', \array_column( $this->printed(), 'Table' ) );
	}

	// ── flush ──

	public function test_flush_sends_the_verb_to_the_live_owner_and_reports_its_rows(): void {
		$this->live_worker( 1 );
		$this->seed_kea( 1, 3 );

		$this->command()->flush( [ 'lab-7:kea' ], [ 'partition' => '1' ] );

		$this->assertSame( [ 'lab-7:kea:config flush' ], $this->answered );
		$this->assertSame( 0, $this->rows_in( 1 ) );
		$this->assertMatchesRegularExpression( '/^lab-7:kea\.p1: [\d.]+[KM]?B released by kea-t\.p1$/', $GLOBALS['_test_wp_cli_logs'][0] );
		$this->assertCount( 1, $GLOBALS['_test_wp_cli_logs'] );
		$this->assertSame( [ 'Flushed 1 Table partition.' ], $GLOBALS['_test_wp_cli_success'] );
	}

	public function test_flush_refuses_a_partition_no_worker_owns_until_the_fleet_is_held(): void {
		$this->seed_kea( 0, 2 );

		$e = $this->caught( fn () => $this->command()->flush( [ 'lab-7:kea' ], [ 'partition' => '0' ] ), 'a down owner was flushed without the hold' );

		$this->assertStringContainsString( 'lab-7:kea.p0: kea-t.p0 is down; run `wp nodes stop` to hold the fleet, flush again, then `wp nodes start`', $e->getMessage() );
		$this->assertSame( 3, $this->rows_in( 0 ), 'nothing was deleted' );
	}

	public function test_flush_refuses_an_idle_owner_naming_it_until_the_fleet_is_held(): void {
		$this->write_tsl( 'kea-t', "var num_partitions = 2\nvar on_demand_idle = 41\nmake_node Table lab-7:kea kea:p<partition> 777 sqlite\n" );
		$this->seed_kea( 0, 2 );

		$e = $this->caught( fn () => $this->command()->flush( [ 'lab-7:kea' ], [ 'partition' => '0' ] ), 'an idle owner, which can spawn at any moment, was flushed without the hold' );

		$this->assertStringContainsString( 'lab-7:kea.p0: kea-t.p0 is idle; run `wp nodes stop` to hold the fleet, flush again, then `wp nodes start`', $e->getMessage() );
		$this->assertSame( 3, $this->rows_in( 0 ), 'nothing was deleted' );
	}

	public function test_flush_refuses_a_stale_owner_even_under_the_hold(): void {
		$this->seed_kea( 0, 2 );
		$lock = "{$this->base}/locks/kea-t.p0.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", '1' );
		\touch( "{$lock}/heartbeat", \time() - 3600 );
		Spawn_Coordinator::set_hold( \time() );

		$e = $this->caught( fn () => $this->command()->flush( [ 'lab-7:kea' ], [ 'partition' => '0' ] ), 'a stale owner\'s partition was flushed' );

		$this->assertStringContainsString( 'lab-7:kea.p0: kea-t.p0 is stale: its lock stands with no heartbeat', $e->getMessage() );
		$this->assertSame( 3, $this->rows_in( 0 ) );
	}

	public function test_a_live_owner_that_never_answers_the_flush_fails_it(): void {
		$this->live_worker( 1, false );
		$this->seed_kea( 1, 2 );

		$e = $this->caught( fn () => $this->command()->flush( [ 'lab-7:kea' ], [ 'partition' => '1', 'timeout' => '4' ] ), 'an unanswered flush reported success' );

		$this->assertStringContainsString( 'lab-7:kea.p1: kea-t.p1 did not answer flush within 4s', $e->getMessage() );
		$this->assertSame( [ 'lab-7:kea:config flush' ], $this->answered );
	}

	public function test_flush_under_the_hold_deletes_a_down_owners_rows_itself(): void {
		$this->seed_kea( 0, 2 );
		Spawn_Coordinator::set_hold( \time() );

		$this->command()->flush( [ 'lab-7:kea' ], [ 'partition' => '0' ] );

		$this->assertSame( 0, $this->rows_in( 0 ) );
		$this->assertMatchesRegularExpression( '/^lab-7:kea\.p0: [\d.]+[KM]?B released under the hold$/', $GLOBALS['_test_wp_cli_logs'][0] );
	}

	public function test_flush_with_no_table_named_asks_first_and_leaves_the_session_store(): void {
		$this->seed_kea( 0, 2 );
		Spawn_Coordinator::set_hold( \time() );
		$session = Command_Auth::mint_session();

		$this->caught( fn () => $this->command()->flush( [], [] ), 'every Table was flushed unasked' );
		$this->assertSame( [ 'Flush every row of 3 declared Table partitions? The session store is left alone.' ], $GLOBALS['_test_wp_cli_confirms'] );
		$this->assertSame( 3, $this->rows_in( 0 ), 'a declined confirmation deletes nothing' );

		$this->command()->flush( [], [ 'yes' => true ] );

		$this->assertSame( 0, $this->rows_in( 0 ) );
		$this->assertSame( $session['secret'], Command_Auth::load_session_record( $session['handle'] )['key'] ?? null, 'the session store is flushed only when named' );
	}

	public function test_flushing_the_session_store_by_name_revokes_every_session(): void {
		$first  = Command_Auth::mint_session();
		$second = Command_Auth::mint_session();
		Table_Node::table( 'owl:p0', 900, 'wpdb' )->store( 'sku-7', 'owl-7' );

		$this->command()->flush( [ Command_Auth::SESSIONS_TABLE ], [] );

		$this->assertNull( Command_Auth::load_session_record( $first['handle'] ) );
		$this->assertNull( Command_Auth::load_session_record( $second['handle'] ) );
		$this->assertSame( 'owl-7', Table_Node::table( 'owl:p0', 900, 'wpdb' )->lookup( 'sku-7' ), 'another namespace is untouched' );
		$this->assertSame( [ Command_Auth::SESSIONS_TABLE . ': 2 rows deleted; every issued session is revoked' ], $GLOBALS['_test_wp_cli_logs'] );
	}

	public function test_a_session_store_that_refuses_the_flush_fails_the_command(): void {
		$GLOBALS['wpdb']->deny['DELETE FROM `wp_newspack_nodes_table`'] = 'Lock wait timeout 4479';

		$e = $this->caught( fn () => $this->command()->flush( [ Command_Auth::SESSIONS_TABLE ], [] ), 'a refused flush reported success' );

		$this->assertSame( 'WP_CLI::error called: ' . Command_Auth::SESSIONS_TABLE . ': Table nodes-sessions: flush failed: wpdb wp_newspack_nodes_table: Lock wait timeout 4479', $e->getMessage() );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_success'] );
	}

	public function test_flush_refuses_a_table_nothing_declares(): void {
		$e = $this->caught( fn () => $this->command()->flush( [ 'lab-7:moa' ], [] ), 'an unknown Table was accepted' );
		$this->assertSame( 'WP_CLI::error called: unknown Table or Ledger lab-7:moa; declared: lab-7:kea, lab-7:owl, ' . Command_Auth::SESSIONS_TABLE, $e->getMessage() );
	}

	public function test_flush_refuses_to_run_as_root(): void {
		CLI::$uid_provider = static fn (): int => 0;
		$e                 = $this->caught( fn () => $this->command()->flush( [ 'lab-7:kea' ], [] ), 'root flushed' );
		$this->assertStringContainsString( 'wp nodes tables flush must run as the same user as the workers', $e->getMessage() );
	}

	public function test_a_live_owner_that_refuses_the_flush_fails_the_command_naming_why(): void {
		$this->live_worker( 1 );
		$this->seed_kea( 1, 3 );
		$tables = \dirname( Table_Node::file( 'lab-7:kea', 1 ) );
		\chmod( $tables, 0555 );
		try {
			$e = $this->caught( fn () => $this->command()->flush( [ 'lab-7:kea' ], [ 'partition' => '1' ] ), 'a failed flush reported success' );
		} finally {
			\chmod( $tables, 0755 );
		}

		$this->assertStringContainsString( 'lab-7:kea.p1: kea-t.p1 refused flush: Table lab-7:kea: flush failed: sqlite', $e->getMessage() );
		$this->assertSame( 4, $this->rows_in( 1 ), 'the file it could not replace keeps its rows' );
	}

	// ── Ledgers ──

	/** Activates `ibis-l`, whose six partitions declare the `lab-7:ibis` Ledger. */
	private function ledger_topology(): void {
		$this->write_tsl( 'ibis-l', "var num_partitions = 6\nmake_node Ledger lab-7:ibis 600 3 qty lo:min hi:max\n" );
		\update_option( 'newspack_nodes_topologies', [ 'kea-t', 'owl-w', 'ibis-l' ] );
		Config::reset();
	}

	/** The `lab-7:ibis` Ledger in partition `$partition`'s worker. */
	private function ibis( int $partition, string ...$columns ): Ledger_Node {
		Core::$var['partition'] = (string) $partition;
		try {
			$ledger = ( new Command_Interpreter_Node() )->make_node( 'Ledger', 'lab-7:ibis', '600', '3', ...( [] === $columns ? [ 'qty', 'lo:min', 'hi:max' ] : $columns ) );
		} finally {
			unset( Core::$var['partition'] );
		}
		$this->assertInstanceOf( Ledger_Node::class, $ledger );
		$ledger->sink( new Capture_Sink_Node() );
		return $ledger;
	}

	/** Two rows partition 3's worker wrote before its process ended. */
	private function seed_ibis(): void {
		$writer = $this->ibis( 3 );
		$t      = (int) Core::right_now();
		$writer->append( [ [ $t, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ], [ $t, 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ] ] );
		$writer->remove_node();
	}

	private function ibis_rows(): int {
		$db = new \PDO( 'sqlite:' . Ledger_Node::file( 'lab-7:ibis' ) );
		return (int) $db->query( 'SELECT COUNT(*) FROM rows' )->fetchColumn();
	}

	public function test_list_shows_a_ledger_once_with_no_partition_and_its_file_size(): void {
		$this->ledger_topology();
		$this->seed_ibis();
		$this->answering( 'ibis-l', 5, true );
		$file = Ledger_Node::file( 'lab-7:ibis' );
		$size = \array_sum( Sqlite_Arm::file_sizes( $file ) );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$ibis = \array_values( \array_filter( $this->printed(), static fn ( array $row ): bool => 'lab-7:ibis' === $row['Table'] ) );
		$this->assertSame(
			[ [ 'Table' => 'lab-7:ibis', 'Partition' => null, 'Backend' => 'ledger', 'TTL' => '1800', 'Owner' => 'ibis-l.p5', 'State' => 'live', 'Store' => $file, 'Bytes' => $size, 'Verbs' => null ] ],
			$ibis
		);
		$this->assertGreaterThan( 0, $size );
		$this->assertSame( [], $this->answered, 'one worker\'s counters are not the Ledger\'s, so none is asked' );

		$this->command()->list_( [], [] );
		$this->assertSame( '-', \array_values( \array_filter( $this->printed(), static fn ( array $row ): bool => 'lab-7:ibis' === $row['Table'] ) )[0]['Partition'] );
	}

	public function test_flush_with_no_live_worker_empties_a_ledger_in_place_from_here(): void {
		$this->ledger_topology();
		$this->seed_ibis();
		$inode = \fileinode( Ledger_Node::file( 'lab-7:ibis' ) );

		$this->command()->flush( [ 'lab-7:ibis' ], [] );

		$this->assertSame( 0, $this->ibis_rows() );
		\clearstatcache();
		$this->assertSame( $inode, \fileinode( Ledger_Node::file( 'lab-7:ibis' ) ), 'never unlinked, since other partitions hold it open' );
		$this->assertSame( [ 'lab-7:ibis: 2 rows deleted; no worker declaring it is live' ], $GLOBALS['_test_wp_cli_logs'] );
		$this->assertSame( [ 'Flushed 1 Ledger.' ], $GLOBALS['_test_wp_cli_success'] );
	}

	public function test_flush_sends_a_ledger_to_one_live_worker_declaring_it_and_it_writes_on(): void {
		$this->ledger_topology();
		$ibis = $this->ibis( 5 );
		$t    = (int) Core::right_now();
		$ibis->append( [ [ $t, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ], [ $t, 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ] ] );
		$this->answering( 'ibis-l', 5, true );
		$inode = \fileinode( Ledger_Node::file( 'lab-7:ibis' ) );

		$this->command()->flush( [ 'lab-7:ibis' ], [] );

		$this->assertSame( [ 'lab-7:ibis:config flush' ], $this->answered );
		$this->assertSame( 0, $this->ibis_rows() );
		\clearstatcache();
		$this->assertSame( $inode, \fileinode( Ledger_Node::file( 'lab-7:ibis' ) ) );
		$this->assertSame( [ 'lab-7:ibis: 2 rows deleted by ibis-l.p5' ], $GLOBALS['_test_wp_cli_logs'] );
		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $ibis->append( [ [ $t, 'sku-41', 'aisle-12', [ 2, 0.5, 4 ] ] ] ) );
	}

	public function test_every_live_worker_declaring_a_ledger_flushes_it(): void {
		$this->ledger_topology();
		$ibis = $this->ibis( 5 );
		$ibis->append( [ [ (int) Core::right_now(), 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] );
		$this->answering( 'ibis-l', 3, true );
		$this->answering( 'ibis-l', 5, true );

		$this->command()->flush( [ 'lab-7:ibis' ], [] );

		$this->assertSame( [ 'lab-7:ibis:config flush', 'lab-7:ibis:config flush' ], $this->answered );
		$this->assertSame( [ 'lab-7:ibis: 1 rows deleted by ibis-l.p3, ibis-l.p5' ], $GLOBALS['_test_wp_cli_logs'] );
		$this->assertSame( 0, $this->ibis_rows() );
	}

	public function test_a_live_worker_running_the_old_columns_refuses_and_the_flush_waits_for_its_restart(): void {
		$this->ledger_topology();
		$old = $this->ibis( 5, 'qty' );
		$old->append( [ [ (int) Core::right_now(), 'sku-41', 'aisle-9', [ 3 ] ] ] );
		$this->answering( 'ibis-l', 5, true );

		$e = $this->caught( fn () => $this->command()->flush( [ 'lab-7:ibis' ], [] ), 'a worker running the old columns flushed' );

		$this->assertSame( 'WP_CLI::error called: lab-7:ibis: ibis-l.p5 refused flush: flush: lab-7:ibis runs qty:sum where its topology declares qty:sum lo:min hi:max; restart this worker (`wp nodes restart`), or hold the fleet (`wp nodes stop`), and flush again', $e->getMessage() );
		$this->assertSame( 1, $this->ibis_rows(), 'nothing was flushed' );

		// The restart: the worker's lock goes, and it holds the old Ledger no more.
		$old->remove_node();
		$this->rmdir_recursive( "{$this->base}/locks/ibis-l.p5.lock.d" );
		$GLOBALS['_test_wp_cli_logs'] = [];
		$this->command()->flush( [ 'lab-7:ibis' ], [] );

		$this->assertSame( [ 'lab-7:ibis: 1 rows deleted; no worker declaring it is live' ], $GLOBALS['_test_wp_cli_logs'] );
		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $this->ibis( 5 )->append( [ [ (int) Core::right_now(), 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ] ] ), 'the Ledger as its topology declares it opens' );
	}

	public function test_a_ledger_only_an_inactive_topology_declares_lists_and_flushes_from_here(): void {
		$this->write_tsl( 'wren-z', "var num_partitions = 2\nmake_node Ledger lab-7:wren 300 4 qty\n" );
		Core::$var['partition'] = '1';
		try {
			$wren = ( new Command_Interpreter_Node() )->make_node( 'Ledger', 'lab-7:wren', '300', '4', 'qty' );
		} finally {
			unset( Core::$var['partition'] );
		}
		$wren->append( [ [ (int) Core::right_now(), 'sku-41', 'aisle-9', [ 3 ] ], [ (int) Core::right_now(), 'sku-43', 'aisle-9', [ 5 ] ] ] );
		$wren->remove_node();
		$file = Ledger_Node::file( 'lab-7:wren' );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$wrens = \array_values( \array_filter( $this->printed(), static fn ( array $row ): bool => 'lab-7:wren' === $row['Table'] ) );
		$this->assertSame(
			[ [ 'Table' => 'lab-7:wren', 'Partition' => null, 'Backend' => 'ledger', 'TTL' => '1200', 'Owner' => 'wren-z.p0', 'State' => 'inactive', 'Store' => $file, 'Bytes' => \array_sum( Sqlite_Arm::file_sizes( $file ) ), 'Verbs' => null ] ],
			$wrens
		);

		$GLOBALS['_test_wp_cli_logs'] = [];
		$this->command()->flush( [ 'lab-7:wren' ], [] );

		$this->assertSame( [ 'lab-7:wren: 2 rows deleted; no worker declaring it is live' ], $GLOBALS['_test_wp_cli_logs'] );
		$db = new \PDO( 'sqlite:' . $file );
		$this->assertSame( 0, (int) $db->query( 'SELECT COUNT(*) FROM rows' )->fetchColumn() );
	}

	public function test_a_ledger_whose_columns_changed_opens_after_the_cli_flushes_it(): void {
		$this->ledger_topology();
		$writer = $this->ibis( 3, 'qty' );
		$writer->append( [ [ (int) Core::right_now(), 'sku-41', 'aisle-9', [ 3 ] ] ] );
		$writer->remove_node();
		$this->caught( fn () => $this->ibis( 5 ), 'a three-column Ledger opened a one-column file' );

		$this->command()->flush( [ 'lab-7:ibis' ], [] );

		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $this->ibis( 5 )->append( [ [ (int) Core::right_now(), 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ] ] ) );
	}

	public function test_flush_refuses_a_ledger_named_with_a_partition(): void {
		$this->ledger_topology();
		$this->seed_ibis();

		$e = $this->caught( fn () => $this->command()->flush( [ 'lab-7:ibis' ], [ 'partition' => '3' ] ), 'a Ledger was narrowed to a partition' );

		$this->assertSame( 'WP_CLI::error called: lab-7:ibis is a Ledger, one file every partition writes; flush it without --partition', $e->getMessage() );
		$this->assertSame( 2, $this->ibis_rows() );
	}

	public function test_flush_with_no_table_named_counts_the_ledgers_apart(): void {
		$this->ledger_topology();

		$this->caught( fn () => $this->command()->flush( [], [] ), 'every store was flushed unasked' );

		$this->assertSame( [ 'Flush every row of 3 declared Table partitions and 1 declared Ledger? The session store is left alone.' ], $GLOBALS['_test_wp_cli_confirms'] );
	}
}
