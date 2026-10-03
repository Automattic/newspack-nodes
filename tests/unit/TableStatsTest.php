<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Durable_Arm;
use Newspack_Nodes\Message;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * A Table's per-verb cost counters: calls, keys or rows asked and answered,
 * the encoded bytes its arm handled, and total and max milliseconds on the
 * monotonic clock, cumulative since the node was built.
 */
#[CoversClass( Table_Node::class )]
#[CoversClass( Durable_Arm::class )]
final class TableStatsTest extends TestCase {
	private const VERBS = [ 'GET', 'MGET', 'MSET', 'ADD', 'TOUCH', 'RM', 'INSERT', 'SADD', 'SMEMBERS', 'PURGE', 'CHECKPOINT' ];

	private string $dir = '';
	private Table_Node $table;
	private Capture_Sink_Node $sink;

	/** Nanoseconds each read of the pinned monotonic clock advances. */
	private int $step = 0;

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'table-stats-' );
		$this->use_base_dir( $this->dir );
		Core::$clock        = static fn (): float => 1790000000.0;
		$ns                 = 0;
		$step               = &$this->step;
		Table_Node::$hrtime = static function () use ( &$ns, &$step ): int {
			$ns += $step;
			return $ns;
		};
		$this->sink  = new Capture_Sink_Node();
		$this->table = $this->worker_table( 'lab-7:kea', 'kea:p3', $this->sink );
	}

	protected function tearDown(): void {
		Table_Node::$hrtime = null;
		Core::$clock        = null;
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	/** A sqlite Table built as a worker's `make_node Table` builds one, partition 3 bound. */
	private function worker_table( string $name, string $namespace, ?Capture_Sink_Node $sink ): Table_Node {
		Core::$var['partition'] = '3';
		try {
			$table = new Table_Node();
			$table->name( $name );
			$table->arguments( [ $namespace, '777', 'sqlite' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		if ( null !== $sink ) {
			$table->sink( $sink );
		}
		return $table;
	}

	/** Fill one request into `$to`, each verb measured as `$ns` nanoseconds. */
	private function ask( int $ns, string|array $value, ?Table_Node $to = null ): void {
		$this->step                = $ns;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = \is_array( $value ) ? Message::TM_REQUEST | Message::TM_STRUCT : Message::TM_REQUEST;
		$message[ Message::FROM ]  = 'asker-9';
		$message[ Message::VALUE ] = $value;
		( $to ?? $this->table )->fill( $message );
	}

	/** Fill one keyed INSERT, measured as `$ns` nanoseconds. */
	private function insert( int $ns, string $key, string $value ): void {
		$this->step                = $ns;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::KEY ]   = $key;
		$message[ Message::VALUE ] = $value;
		$this->table->fill( $message );
	}

	/** Encoded bytes a sqlite table of lab-7:kea's file holds. */
	private function stored_bytes( string $sql_table ): int {
		$db = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		return (int) $db->query( "SELECT SUM( length( CAST( value AS BLOB ) ) ) FROM {$sql_table}" )->fetchColumn();
	}

	/** @return array{calls:int,asked:int,answered:int,bytes:int,total_ms:float,max_ms:float,errors:int} */
	private static function row( int $calls, int $asked, int $answered, float $total_ms, float $max_ms, int $bytes = 0, int $errors = 0 ): array {
		return [
			'calls'    => $calls,
			'asked'    => $asked,
			'answered' => $answered,
			'bytes'    => $bytes,
			'total_ms' => $total_ms,
			'max_ms'   => $max_ms,
			'errors'   => $errors,
		];
	}

	/** @return array<string,array<string,int|float>> Every verb at zero. */
	private static function zeroes(): array {
		return \array_fill_keys( self::VERBS, self::row( 0, 0, 0, 0.0, 0.0 ) );
	}

	/**
	 * @param array<string,array<string,int|float>> $stats
	 * @return array<string,array<string,int|float>> The counters with bytes zeroed.
	 */
	private static function without_bytes( array $stats ): array {
		return \array_map( static fn ( array $row ): array => \array_replace( $row, [ 'bytes' => 0 ] ), $stats );
	}

	public function test_a_refused_request_counts_an_error_against_its_verb(): void {
		$this->ask( 3000000, "TOUCH soon kea-41\n" );
		$this->ask( 5000000, "TOUCH -7 kea-42\n" );
		$this->ask( 1000000, "GET kea-43\n" );

		$stats = $this->table->stats();
		$this->assertSame( 2, $stats['TOUCH']['errors'] );
		$this->assertSame( 2, $stats['TOUCH']['calls'] );
		$this->assertSame( 0, $stats['GET']['errors'] );
	}

	public function test_a_failed_read_counts_an_error(): void {
		$this->insert( 1000000, 'kea-41', 'v-41' );
		( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->exec( 'DROP TABLE kv' );
		$this->ask( 2000000, "MGET kea-41 kea-42\n" );
		$this->ask( 2000000, "GET kea-41\n" );

		$this->assertSame( 1, $this->table->stats()['MGET']['errors'] );
		$this->assertSame( 1, $this->table->stats()['GET']['errors'] );
	}

	public function test_a_failed_member_read_counts_an_error(): void {
		$this->ask( 1000000, [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1 ] ] ] ] );
		( new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) ) )->exec( 'DROP TABLE members' );
		$this->ask( 2000000, "SMEMBERS 9 word:kea\n" );

		$this->assertSame( 1, $this->table->stats()['SMEMBERS']['errors'] );
	}

	public function test_an_unknown_verb_counts_no_row(): void {
		$this->ask( 1000000, "FROB kea-41\n" );
		$this->assertSame( self::zeroes(), $this->table->stats() );
	}

	public function test_reset_stats_zeroes_the_errors(): void {
		$this->ask( 3000000, "TOUCH soon kea-41\n" );
		$this->table->reset_stats();
		$this->assertSame( 0, $this->table->stats()['TOUCH']['errors'] );
	}

	public function test_every_verb_starts_at_zero(): void {
		$this->assertSame( self::zeroes(), $this->table->stats() );
	}

	public function test_counters_tally_a_seeded_mix_of_verbs(): void {
		$this->ask( 1250000, [ 'MSET' => [ 'sku-41' => [ 'a' ], 'sku 42' => [ 'b' ], 'sku-43' => [ 'c', 37 ] ] ] );
		$this->ask( 2500000, "MGET sku-41 sku-42 sku-43\n" );
		$this->ask( 4000000, "MGET sku-43\n" );
		$this->ask( 750000, "GET sku-41 sku-43\n" );
		$this->ask( 500000, [ 'ADD' => [ 'sku-41' => [ 'x' ], 'sku-44' => [ 'y' ] ] ] );
		$this->ask( 300000, "TOUCH 900 sku-41 sku-49\n" );
		$this->ask( 200000, "RM sku-44 sku-49\n" );
		$this->insert( 125000, 'sku-47', 'owl' );
		$this->insert( 175000, 'sku-47', '' );
		$this->ask( 3000000, [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => 1, 'u-43' => 3 ] ], 'word:owl' => [ [ 'u-47' => 7 ], 777 ], 'bad set' => [ [ 'u-9' => 9 ] ] ] ] );
		$this->ask( 1100000, "SMEMBERS 9 word:kea word:emu\n" );
		$this->ask( 5000000, "SCAN urltoken 5\n" );
		$this->step  = 6000000;
		Core::$clock = static fn (): float => 1790000038.0;
		Table_Node::tick( 1790000038 );

		$stats      = $this->table->stats();
		$checkpoint = $stats['CHECKPOINT'];
		unset( $stats['CHECKPOINT'] );
		$this->assertSame( [ 1, 6.0, 6.0 ], [ $checkpoint['calls'], $checkpoint['total_ms'], $checkpoint['max_ms'] ] );
		$this->assertGreaterThan( 0, $checkpoint['asked'] );
		$this->assertSame( $checkpoint['asked'], $checkpoint['answered'], 'the tick wrote every frame back' );
		$this->assertSame(
			[
				'GET'      => self::row( 1, 1, 1, 0.75, 0.75 ),
				'MGET'     => self::row( 2, 4, 3, 6.5, 4.0 ),
				'MSET'     => self::row( 1, 3, 2, 1.25, 1.25 ),
				'ADD'      => self::row( 1, 2, 1, 0.5, 0.5 ),
				'TOUCH'    => self::row( 1, 2, 1, 0.3, 0.3 ),
				'RM'       => self::row( 1, 2, 1, 0.2, 0.2 ),
				'INSERT'   => self::row( 2, 2, 2, 0.3, 0.175 ),
				'SADD'     => self::row( 1, 3, 3, 3.0, 3.0 ),
				'SMEMBERS' => self::row( 1, 2, 2, 1.1, 1.1 ),
				'PURGE'    => self::row( 1, Table_Node::PURGE_BATCH_ROWS, 1, 6.0, 6.0 ),
			],
			self::without_bytes( $stats ),
			'an unknown verb counts nowhere'
		);
	}

	public function test_bytes_are_the_encoded_sizes_the_arm_stored_and_returned(): void {
		$this->ask( 1000, [ 'MSET' => [ 'sku-41' => [ [ 'usd' => 1250, 'eur' => 1180 ] ], 'sku-43' => [ \str_repeat( 'kea', 41 ) ] ] ] );
		$kv = $this->stored_bytes( 'kv' );
		$this->ask( 1000, "MGET sku-41 sku-43 sku-49\n" );
		$this->insert( 1000, 'sku-47', \str_repeat( 'owl', 77 ) );
		$inserted = $this->stored_bytes( 'kv' ) - $kv;
		$this->ask( 1000, [ 'SADD' => [ 'word:kea' => [ [ 'u-41' => [ 'w' => 3 ], 'u-43' => 'emu' ] ] ] ] );
		$members = $this->stored_bytes( 'members' );
		$this->ask( 1000, "SMEMBERS 9 word:kea\n" );

		$bytes = \array_map( static fn ( array $row ): int => $row['bytes'], $this->table->stats() );
		$this->assertGreaterThan( 0, $kv );
		$this->assertGreaterThan( 231, $inserted );
		$this->assertGreaterThan( 0, $members );
		$this->assertSame(
			[ 'MGET' => $kv, 'MSET' => $kv, 'INSERT' => $inserted, 'SADD' => $members, 'SMEMBERS' => $members ],
			\array_intersect_key( $bytes, \array_flip( [ 'MSET', 'MGET', 'INSERT', 'SADD', 'SMEMBERS' ] ) )
		);
	}

	public function test_a_verb_that_throws_still_counts_its_call_and_time(): void {
		$owl = $this->worker_table( 'lab-7:owl', 'owl:p3', null );
		$owl->store( 'sku-41', 'owl-41' );
		try {
			$this->ask( 2750000, "GET sku-41\n", $owl );
			$this->fail( 'a Table with no sink cannot reply' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'sink', $e->getMessage() );
		}
		$this->assertSame( self::row( 1, 1, 1, 2.75, 2.75 ), \array_replace( $owl->stats()['GET'], [ 'bytes' => 0 ] ) );
	}

	public function test_the_stats_verb_answers_the_counters(): void {
		$this->ask( 1500000, "MGET sku-41 sku-42\n" );
		$stats = Core::node( 'lab-7:kea:config' )->dispatch( 'stats' );
		$this->assertSame( self::row( 1, 2, 0, 1.5, 1.5 ), $stats['MGET'] );
		$this->assertSame( $this->table->stats(), $stats );
	}

	public function test_reset_stats_answers_the_counters_it_zeroed(): void {
		$this->ask( 1500000, "MGET sku-41 sku-42\n" );
		$config = Core::node( 'lab-7:kea:config' );
		$this->assertSame( self::row( 1, 2, 0, 1.5, 1.5 ), $config->dispatch( 'reset_stats' )['MGET'] );
		$this->assertSame( self::zeroes(), $config->dispatch( 'stats' ) );
	}

	public function test_stats_only_reads_so_it_takes_no_action(): void {
		$this->ask( 1500000, "MGET sku-41 sku-42\n" );
		$config = Core::node( 'lab-7:kea:config' );
		try {
			$config->dispatch( 'stats', [ 'reset' ] );
			$this->fail( 'stats zeroed its counters' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertSame( 1, $this->table->stats()['MGET']['calls'], 'a refused stats zeroes nothing' );
		}
	}

	public function test_a_mount_keeps_its_own_counters_and_refuses_reset_stats(): void {
		$this->table->store( 'sku-41', 'kea-41' );
		$mount = Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 777, 'backend' => 'sqlite' ], $this->sink );
		$this->ask( 900000, "MGET sku-41 sku-42\n", $mount );
		$this->assertSame( self::row( 1, 2, 1, 0.9, 0.9 ), \array_replace( $mount->stats()['MGET'], [ 'bytes' => 0 ] ) );
		$this->assertSame( self::zeroes(), $this->table->stats(), 'the worker Table counts only its own' );
		try {
			Core::node( 'lab-7:kea.p3:config' )->dispatch( 'reset_stats' );
			$this->fail( 'a mount serves reads only' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'reset_stats: lab-7:kea.p3 is a mounted Table, which serves reads only', $e->getMessage() );
		}
		$this->assertSame( 1, $mount->stats()['MGET']['calls'], 'a refused reset zeroes nothing' );
	}

	/** Every stderr line written while `$run` runs, past the process identity. */
	private function stderr_of( \Closure $run ): array {
		$logged = [];
		$hook   = static function ( string $line ) use ( &$logged ): void {
			$logged[] = \preg_replace( '/^[^:]*\]: /', '', \rtrim( $line, "\n" ) );
		};
		\add_action( 'newspack_nodes/stderr', $hook );
		try {
			$run();
		} finally {
			\remove_action( 'newspack_nodes/stderr', $hook );
		}
		return $logged;
	}

	public function test_a_traced_table_sums_each_tick_into_one_line_and_a_quiet_tick_into_none(): void {
		$this->ask( 9000000, "MGET sku-40\n" );
		$this->table->debug_state( 1 );
		$this->ask( 1250000, [ 'MSET' => [ 'sku-41' => [ 'a' ], 'sku-43' => [ 'c', 37 ] ] ] );
		$this->ask( 2500000, "MGET sku-41\n" );
		$this->ask( 4000000, "MGET sku-43\n" );
		$this->step = 6000000;
		$first      = $this->stderr_of( static fn () => Table_Node::tick( 1790000000 ) );
		$this->assertSame( [ 'lab-7:kea: DEBUG: MGET 2 6.5ms, MSET 1 1.25ms, PURGE 1 6ms, CHECKPOINT 1 6ms' ], $first, 'calls before the trace began are not in it' );
		$this->assertSame( [], $this->stderr_of( static fn () => Table_Node::tick( 1790000001 ) ), 'nothing was called since' );
	}

	public function test_a_trace_turned_off_and_on_again_sums_from_when_it_came_back(): void {
		Table_Node::tick( 1790000000 );
		$this->table->debug_state( 1 );
		$this->ask( 1250000, [ 'MSET' => [ 'sku-41' => [ 'a' ] ] ] );
		$this->table->debug_state( 0 );
		$this->ask( 2500000, "MGET sku-41\n" );
		$this->table->debug_state( 3 );
		$this->ask( 750000, "GET sku-41\n" );
		$this->assertSame( [ 'lab-7:kea: DEBUG: GET 1 0.75ms' ], $this->stderr_of( static fn () => Table_Node::tick( 1790000001 ) ) );
	}

	public function test_a_trace_across_a_reset_sums_what_came_after_it(): void {
		Table_Node::tick( 1790000000 );
		$this->table->debug_state( 1 );
		$this->ask( 2500000, "MGET sku-41\n" );
		$this->ask( 2500000, "MGET sku-43\n" );
		$this->assertSame( [ 'lab-7:kea: DEBUG: MGET 2 5ms' ], $this->stderr_of( static fn () => Table_Node::tick( 1790000001 ) ) );
		$this->table->reset_stats();
		$this->ask( 750000, "MGET sku-47\n" );
		$this->assertSame( [ 'lab-7:kea: DEBUG: MGET 1 0.75ms' ], $this->stderr_of( static fn () => Table_Node::tick( 1790000002 ) ) );
	}

	public function test_an_untraced_table_writes_no_trace_line(): void {
		$volatile = new Table_Node();
		$volatile->name( 'lab-7:owl' );
		$memd       = Core::$memd;
		Core::$memd = new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
		try {
			$volatile->arguments( [ 'owl:p3', '777', 'memcache' ] );
			$volatile->sink( $this->sink );
			$lines = $this->stderr_of(
				function () use ( $volatile ): void {
					$this->ask( 1250000, [ 'MSET' => [ 'sku-41' => [ 'a' ] ] ] );
					$this->ask( 1250000, [ 'MSET' => [ 'sku-41' => [ 'a' ] ] ], $volatile );
					Table_Node::tick( 1790000000 );
				}
			);
			$this->assertSame( [], \array_values( \array_filter( $lines, static fn ( string $line ): bool => \str_contains( $line, 'DEBUG:' ) ) ) );
			$volatile->debug_state( 1 );
			$this->ask( 2500000, "MGET sku-41\n", $volatile );
			$this->assertSame( [ 'lab-7:owl: DEBUG: MGET 1 2.5ms' ], $this->stderr_of( static fn () => Table_Node::tick( 1790000001 ) ), 'a volatile Table traces on the tick too' );
		} finally {
			Core::$memd = $memd;
		}
	}

	public function test_dump_metadata_and_dump_node_carry_the_counters(): void {
		$this->ask( 1500000, "MGET sku-41\n" );
		$this->assertSame( [ 'verb_stats' => $this->table->stats() ], $this->table->dump_metadata() );
		$this->assertSame( $this->table->stats(), $this->table->dump_node()['verb_stats'] );
	}
}
