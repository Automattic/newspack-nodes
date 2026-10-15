<?php
/**
 * `wp nodes tables list`: every declared Table, partition by partition, plus
 * the command-session store; a live owner is asked over its command channel.
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
use Newspack_Nodes\Crawler_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Router_Node;
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
		$this->write_tsl( 'kea-t', "var num_partitions = 2\nmake_node Table lab-7:kea kea:p{partition} 777 sqlite\n" );
		$this->write_tsl( 'owl-w', "make_node Table lab-7:owl owl:p{partition} 37 wpdb\n" );
		\update_option( 'newspack_nodes_topologies', [ 'kea-t', 'owl-w' ] );
		Config::reset();
		foreach ( [ 'lines', 'logs', 'warns', 'errors', 'success', 'tables' ] as $stream ) {
			$GLOBALS[ "_test_wp_cli_{$stream}" ] = [];
		}
	}

	protected function tearDown(): void {
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

	/**
	 * A live `kea-t.p{partition}` holding its `lab-7:kea` Table.
	 *
	 * @param bool $answers False for a worker that reads commands and answers none.
	 */
	private function live_worker( int $partition, bool $answers = true ): Table_Node {
		return $this->live_table( 'kea-t', 'lab-7:kea', [ "kea:p{$partition}", '777', 'sqlite' ], $partition, $answers );
	}

	/**
	 * A live `{topology}.p{partition}` holding the Table `$name`.
	 *
	 * @param array<int,string> $args    The Table's `make_node` arguments.
	 * @param bool              $answers False for a worker that reads commands and answers none.
	 */
	private function live_table( string $topology, string $name, array $args, int $partition, bool $answers = true ): Table_Node {
		Core::$var['partition'] = (string) $partition;
		try {
			$table = new Table_Node();
			$table->name( $name );
			$table->arguments( $args );
		} finally {
			unset( Core::$var['partition'] );
		}
		$table->sink( new Capture_Sink_Node() );
		$this->answer_channel( $topology, $partition, $answers );
		return $table;
	}

	/**
	 * A live `crawl-c.p0` holding Crawler `crawl-8812`, which owns its
	 * `crawl-8812:seen` Table. The Crawler hitchhikes `_router` as it is
	 * built, and that Router leaves before the CLI mounts its own.
	 */
	private function live_crawler(): Table_Node {
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		Core::$var['partition'] = '0';
		try {
			$crawler = new Crawler_Node();
			$crawler->name( 'crawl-8812' );
			$crawler->sink( new Capture_Sink_Node() );
			$crawler->arguments( [ '5501' ] );
		} finally {
			unset( Core::$var['partition'] );
			$router->remove_node();
		}
		$this->answer_channel( 'crawl-c', 0 );
		return Core::node( 'crawl-8812:seen' );
	}

	/**
	 * A live `{topology}.p{partition}`'s lock dir with a fresh heartbeat, and
	 * the read of its input channel a worker runs, verifying each command and
	 * answering it through the interpreter it addresses onto its output
	 * channel, TO the command's FROM; an address no node answers to bounces
	 * as the Router bounces it.
	 *
	 * @param bool $answers False for a worker that reads commands and answers none.
	 */
	private function answer_channel( string $topology, int $partition, bool $answers = true ): void {
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
					$to                     = Core::as_string( $command[ Message::TO ] );
					$reply                  = Message::new_message();
					$reply[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_RESPONSE;
					$reply[ Message::FROM ] = $to;
					$reply[ Message::TO ]   = $command[ Message::FROM ];
					$interpreter            = Core::node( $to );
					if ( ! $interpreter instanceof Command_Interpreter_Node ) {
						// Router_Node::send_error()'s bounce: a bare string VALUE.
						$reply[ Message::TYPE ]  = Message::TM_ERROR;
						$reply[ Message::VALUE ] = "NOT_AVAILABLE\n";
						$replies->fill( $reply );
						return;
					}
					try {
						$payload = $interpreter->dispatch( $verb );
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

	/** What the filesystem allocates a SQLite database's files, read back. */
	private static function disk_of( string $file ): int {
		$disk = 0;
		foreach ( [ $file, "{$file}-wal", "{$file}-shm" ] as $part ) {
			\clearstatcache( true, $part );
			$disk += \is_file( $part ) ? (int) \stat( $part )['blocks'] * 512 : 0;
		}
		return $disk;
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
				[ 'Table' => 'lab-7:kea', 'Partition' => 0, 'Backend' => 'sqlite', 'TTL' => '777', 'Owner' => 'kea-t.p0', 'State' => 'down', 'Store' => $file, 'Bytes' => $size, 'Disk' => self::disk_of( $file ), 'Verbs' => null ],
				[ 'Table' => 'lab-7:kea', 'Partition' => 1, 'Backend' => 'sqlite', 'TTL' => '777', 'Owner' => 'kea-t.p1', 'State' => 'down', 'Store' => Table_Node::file( 'lab-7:kea', 1 ), 'Bytes' => 0, 'Disk' => 0, 'Verbs' => null ],
				[ 'Table' => 'lab-7:owl', 'Partition' => 0, 'Backend' => 'wpdb', 'TTL' => '37', 'Owner' => 'owl-w.p0', 'State' => 'down', 'Store' => 'wp_newspack_nodes_table', 'Bytes' => null, 'Disk' => null, 'Verbs' => null ],
				[ 'Table' => Command_Auth::SESSIONS_TABLE, 'Partition' => 0, 'Backend' => 'wpdb', 'TTL' => '60-86400', 'Owner' => '-', 'State' => '-', 'Store' => 'wp_newspack_nodes_table', 'Bytes' => null, 'Disk' => null, 'Verbs' => null ],
			],
			$this->printed()
		);
		$this->assertSame( 'json', \end( $GLOBALS['_test_wp_cli_tables'] )['format'] );
	}

	/** The session store's row is its declaration: listing it opens nothing, so a store that will not open lists all the same. */
	public function test_list_names_the_session_store_without_opening_it(): void {
		$GLOBALS['wpdb']->deny['CREATE TABLE'] = 'CREATE command denied 1030';

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertSame( [ 'Table' => Command_Auth::SESSIONS_TABLE, 'Partition' => 0, 'Backend' => 'wpdb', 'TTL' => '60-86400', 'Owner' => '-', 'State' => '-', 'Store' => 'wp_newspack_nodes_table', 'Bytes' => null, 'Disk' => null, 'Verbs' => null ], \array_slice( $this->printed(), -1 )[0] );
	}

	public function test_list_counts_a_sqlite_partitions_shm_in_its_bytes(): void {
		$this->seed_kea( 0, 3 );
		$file = Table_Node::file( 'lab-7:kea', 0 );
		\file_put_contents( "{$file}-shm", \str_repeat( 's', 4099 ) );
		\clearstatcache();
		$size = \filesize( $file ) + ( \is_file( "{$file}-wal" ) ? \filesize( "{$file}-wal" ) : 0 ) + 4099;

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertSame( $size, $this->printed()[0]['Bytes'] );
		$this->assertSame( self::disk_of( $file ), $this->printed()[0]['Disk'] );
		$this->assertNotSame( $size, $this->printed()[0]['Disk'], 'blocks must differ from bytes here, or the test proves nothing' );
	}

	public function test_list_reads_an_on_demand_owner_with_no_lock_as_idle(): void {
		$this->write_tsl( 'kea-t', "var num_partitions = 2\nvar on_demand_idle = 41\nmake_node Table lab-7:kea kea:p{partition} 777 sqlite\n" );

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
		$this->assertSame( '-', $this->printed()[2]['Disk'], 'a wpdb Table has no file to size' );
		$this->assertMatchesRegularExpression( '/\d/', $this->printed()[1]['Disk'], 'a SQLite partition shows its disk readable' );
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

	/** Registers `emu-z`, declaring a `sqlite` Table over two partitions, and `ant-x`, including it; no option activates either. */
	private function register_inactive_emu(): void {
		$this->write_tsl( 'emu-z', "var num_partitions = 2\nmake_node Table lab-7:emu emu:p{partition} 4242 sqlite\n" );
		$this->write_tsl( 'ant-x', "var num_partitions = 2\ninclude emu-z\n" );
	}

	/** An `emu` partition's file, written as its worker would write it. */
	private function seed_emu( int $partition, int $rows ): void {
		$arm = new Sqlite_Arm( Table_Node::file( 'lab-7:emu', $partition ), 'emu:p3' );
		for ( $i = 1; $i <= $rows; ++$i ) {
			$arm->set( "emu:p{$partition}:sku-{$i}", "emu-{$i}", 0 );
		}
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
				[ 'Table' => 'lab-7:emu', 'Partition' => 0, 'Backend' => 'sqlite', 'TTL' => '4242', 'Owner' => '-', 'State' => 'inactive', 'Store' => Table_Node::file( 'lab-7:emu', 0 ), 'Bytes' => 0, 'Disk' => 0, 'Verbs' => null ],
				[ 'Table' => 'lab-7:emu', 'Partition' => 1, 'Backend' => 'sqlite', 'TTL' => '4242', 'Owner' => '-', 'State' => 'inactive', 'Store' => $file, 'Bytes' => $size, 'Disk' => self::disk_of( $file ), 'Verbs' => null ],
			],
			$emu
		);
		$this->assertGreaterThan( 0, $size );
	}

	/**
	 * A deactivated topology's worker writes its Tables until it exits, so it
	 * still owns them; `emu-z` runs because the catalog lists `ant-x` first.
	 */
	public function test_list_names_an_inactive_topologys_worker_that_still_runs_as_owner(): void {
		$this->register_inactive_emu();
		$this->live_table( 'emu-z', 'lab-7:emu', [ 'emu:p1', '4242', 'sqlite' ], 1 );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$emu = \array_values( \array_filter( $this->printed(), static fn ( array $row ): bool => 'lab-7:emu' === $row['Table'] ) );
		$this->assertSame( [ [ '-', 'inactive' ], [ 'emu-z.p1', 'live' ] ], \array_map( static fn ( array $row ): array => [ $row['Owner'], $row['State'] ], $emu ) );
		$this->assertSame( [ 'lab-7:emu:config stats' ], $this->answered, 'the running worker is the one asked' );
	}

	public function test_list_reads_an_inactive_topologys_stale_worker_as_its_owner(): void {
		$this->register_inactive_emu();
		\mkdir( "{$this->base}/locks/emu-z.p1.lock.d", 0755, true );
		\touch( "{$this->base}/locks/emu-z.p1.lock.d", \time() - ( \Newspack_Nodes\Lock_Node::ORPHAN_GRACE_S + 61 ) );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$emu = \array_values( \array_filter( $this->printed(), static fn ( array $row ): bool => 'lab-7:emu' === $row['Table'] ) );
		$this->assertSame( [ 'emu-z.p1', 'stale' ], [ $emu[1]['Owner'], $emu[1]['State'] ] );
	}

	/** Under the hold, a running worker of an inactive declarer owns the partition over the held active one. */
	public function test_list_under_the_hold_names_an_inactive_declarers_running_worker_as_owner(): void {
		$this->write_tsl( 'gnu-y', "var num_partitions = 4\nmake_node Table lab-7:kea kea:p{partition} 777 sqlite\n" );
		$this->live_table( 'gnu-y', 'lab-7:kea', [ 'kea:p0', '777', 'sqlite' ], 0 );
		Spawn_Coordinator::set_hold( \time() );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$kea = \array_values( \array_filter( $this->printed(), static fn ( array $row ): bool => 'lab-7:kea' === $row['Table'] ) );
		$this->assertSame( [ [ 'gnu-y.p0', 'live' ], [ 'kea-t.p1', 'held' ] ], \array_map( static fn ( array $row ): array => [ $row['Owner'], $row['State'] ], \array_slice( $kea, 0, 2 ) ) );
		$this->assertSame( [ 'lab-7:kea:config stats' ], $this->answered, 'the running worker is the one asked' );
	}

	public function test_a_table_an_active_and_an_inactive_topology_both_declare_is_owned_by_the_active_one_alone(): void {
		$this->write_tsl( 'gnu-y', "var num_partitions = 4\nmake_node Table lab-7:kea kea:p{partition} 777 sqlite\n" );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$kea = \array_filter( $this->printed(), static fn ( array $row ): bool => 'lab-7:kea' === $row['Table'] );
		$this->assertSame( [ 'kea-t.p0', 'kea-t.p1', '-', '-' ], \array_column( \array_values( $kea ), 'Owner' ), 'the active declarer owns what it declares; the partitions beyond have no owner' );
		$this->assertSame( [ 'down', 'down', 'inactive', 'inactive' ], \array_column( \array_values( $kea ), 'State' ) );
	}

	public function test_an_inactive_topology_that_will_not_read_is_warned_about_and_the_rest_lists(): void {
		$this->write_tsl( 'emu-z', "include no-such-topology\n" );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertCount( 1, $GLOBALS['_test_wp_cli_warns'] );
		$this->assertStringStartsWith( 'emu-z: ', $GLOBALS['_test_wp_cli_warns'][0] );
		$this->assertContains( 'lab-7:kea', \array_column( $this->printed(), 'Table' ) );
	}

	public function test_an_inactive_topology_whose_line_its_class_refuses_is_warned_about_and_the_rest_lists(): void {
		$this->write_tsl( 'emu-z', "make_node Remote_Source pull:ibis ibis-4403 /var/ibis/off /var/ibis/dl egret.p3=heron-8812\n" );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$this->assertCount( 1, $GLOBALS['_test_wp_cli_warns'] );
		$this->assertStringStartsWith( 'emu-z: ', $GLOBALS['_test_wp_cli_warns'][0] );
		$this->assertStringContainsString( 'too many arguments: 4 given, 3 accepted', \html_entity_decode( $GLOBALS['_test_wp_cli_warns'][0], \ENT_QUOTES ) );
		$this->assertContains( 'lab-7:kea', \array_column( $this->printed(), 'Table' ) );
	}

	public function test_list_reads_the_counters_of_a_table_its_crawler_owns(): void {
		$this->write_tsl( 'crawl-c', "make_node Crawler crawl-8812 5501\n" );
		\update_option( 'newspack_nodes_topologies', [ 'kea-t', 'owl-w', 'crawl-c' ] );
		Config::reset();
		$insert                    = Message::new_message();
		$insert[ Message::TYPE ]   = Message::TM_BYTESTREAM;
		$insert[ Message::KEY ]    = 'https://site-8812.example/c';
		$insert[ Message::VALUE ]  = '1';
		$this->live_crawler()->fill( $insert );

		$this->command()->list_( [], [ 'format' => 'json' ] );

		$rows = \array_column( $this->printed(), null, 'Table' );
		$this->assertSame( 1, $rows['crawl-8812:seen']['Verbs']['INSERT']['calls'] ?? null, 'the owned Table answered stats' );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_warns'] );
	}

}
