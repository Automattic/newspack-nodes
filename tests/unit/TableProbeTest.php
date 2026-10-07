<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Node;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Table_Probe_Node;
use Newspack_Nodes\Tablestats_Record;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Table_Probe sweeps this process's named Tables and emits one positional
 * Tablestats_Record per Table per tick into its sink, the shared
 * tablestats log.
 */
#[CoversClass( Table_Probe_Node::class )]
#[CoversClass( Probe_Node::class )]
final class TableProbeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		Core::$now = 1000;
		// Topology_Loader binds both halves of the worker id, as in a worker.
		Core::$var['topology']  = 'table-probe-2291';
		Core::$var['partition'] = '4';
		// Every worker graph holds the `_router` a probe's sweep timer rides.
		( new \Newspack_Nodes\Router_Node() )->name( '_router' );
	}

	/** A registered Table whose probe_stats() answers canned records. */
	private function stub_table( string $name, array $records ): Table_Node {
		$t = new class() extends Table_Node {
			/** @var list<array<int,mixed>> */
			public array $canned = [];
			public function probe_stats(): array {
				return $this->canned;
			}
		};
		$t->canned = $records;
		$t->name( $name );
		return $t;
	}

	private static function record( string $identity ): array {
		return [
			Tablestats_Record::IDENTITY     => $identity,
			Tablestats_Record::BACKEND      => 'sqlite',
			Tablestats_Record::VERBS        => [ 'GET' => [ 4, 4, 3, 0, 1.25, 0.5, 0 ] ],
			Tablestats_Record::PURGE_BEHIND => 0,
			Tablestats_Record::WAL_STALLED  => 0,
			Tablestats_Record::FILE_BYTES   => 8192,
			Tablestats_Record::ELAPSED_MS   => 15000,
		];
	}

	private function probe( Capture_Sink_Node $capture ): Table_Probe_Node {
		$probe = new Table_Probe_Node();
		$probe->name( 'tablestats' );
		$probe->arguments( [] );
		$probe->target( 'tablestats:log' );
		$probe->sink( $capture );
		return $probe;
	}

	public function test_fire_emits_one_record_per_named_table(): void {
		$this->stub_table( 'flame-stats:url', [ self::record( 'flame-stats:url.p2' ) ] );
		$this->stub_table( 'flame-stats:aggregate', [ self::record( 'flame-stats:aggregate.p2' ) ] );
		$capture = new Capture_Sink_Node();
		$this->probe( $capture )->fire_cb();

		$this->assertCount( 2, $capture->captured );
		foreach ( $capture->captured as $msg ) {
			$this->assertSame( Message::TM_STRUCT, $msg[ Message::TYPE ] );
			$this->assertSame( 'tablestats:log', $msg[ Message::TO ] );
			$this->assertSame( Core::$now, $msg[ Message::TIMESTAMP ] );
		}
		$ids = \array_map( static fn ( $m ) => $m[ Message::VALUE ][ Tablestats_Record::IDENTITY ], $capture->captured );
		\sort( $ids );
		$this->assertSame( [ 'flame-stats:aggregate.p2', 'flame-stats:url.p2' ], $ids );
	}

	public function test_every_record_of_one_sweep_carries_the_sweep_instant(): void {
		$reads       = 0;
		Core::$clock = static function () use ( &$reads ): float {
			return 1790000123.25 + 0.0137 * $reads++;
		};
		foreach ( [ 'flame-stats:a', 'flame-stats:b', 'flame-stats:c' ] as $name ) {
			$t = new class() extends Table_Node {
				public string $identity = '';
				public function probe_stats(): array {
					// Swept work reads the clock, moving Core::$now mid-sweep.
					Core::right_now();
					return [ [ Tablestats_Record::IDENTITY => $this->identity ] + $this->canned_record() ];
				}
				/** @return array<int,mixed> */
				private function canned_record(): array {
					return [
						Tablestats_Record::BACKEND      => 'sqlite',
						Tablestats_Record::VERBS        => [],
						Tablestats_Record::PURGE_BEHIND => 0,
						Tablestats_Record::WAL_STALLED  => 0,
						Tablestats_Record::FILE_BYTES   => 1,
						Tablestats_Record::ELAPSED_MS   => 1,
					];
				}
			};
			$t->identity = $name;
			$t->name( $name );
		}
		Core::$now = 1790000000.5;
		$capture   = new Capture_Sink_Node();
		$probe     = $this->probe( $capture );
		$probe->fire_cb();
		Core::$clock = null;

		$this->assertCount( 3, $capture->captured );
		$stamps = \array_unique( \array_map( static fn ( $m ) => $m[ Message::TIMESTAMP ], $capture->captured ) );
		$this->assertCount( 1, $stamps );
		$this->assertSame( 1790000000.5, \reset( $stamps ) );
	}

	public function test_a_record_names_its_worker_in_from(): void {
		$this->stub_table( 'flame-stats:url', [ self::record( 'flame-stats:url.p3' ) ] );
		Core::$var['topology']  = 'job-worker-4417';
		Core::$var['partition'] = '3';
		$capture                = new Capture_Sink_Node();
		$this->probe( $capture )->fire_cb();

		$this->assertSame( 'job-worker-4417.p3/tablestats', $capture->captured[0][ Message::FROM ] );
	}

	/**
	 * A probe runs only in a worker, where `Topology_Loader` binds both halves
	 * of the worker id before `make_node` hands the probe its arguments, so a
	 * missing or non-canonical one is refused there, by name, before a timer
	 * is armed — never on a later tick.
	 *
	 * @return array<string,array{array<string,string>,string}>
	 */
	public static function unbound_workers(): array {
		return [
			'no topology'               => [ [ 'partition' => '5' ], 'tablestats: no topology bound; a probe runs only in a worker' ],
			'an empty topology'         => [ [ 'topology' => '', 'partition' => '5' ], 'tablestats: no topology bound; a probe runs only in a worker' ],
			'no partition'              => [ [ 'topology' => 'job-worker-4417' ], 'tablestats: no partition bound; a probe runs only in a worker' ],
			'a non-canonical partition' => [ [ 'topology' => 'job-worker-4417', 'partition' => '1e2' ], 'bound partition 1e2 is not canonical' ],
		];
	}

	/** @param array<string,string> $bound */
	#[DataProvider( 'unbound_workers' )]
	public function test_a_probe_refuses_its_arguments_outside_a_worker( array $bound, string $refusal ): void {
		unset( Core::$var['topology'], Core::$var['partition'] );
		foreach ( $bound as $key => $value ) {
			Core::$var[ $key ] = $value;
		}
		$probe = new Table_Probe_Node();
		$probe->name( 'tablestats' );

		try {
			$probe->arguments( [ '37' ] );
			$this->fail( 'a probe took its arguments with no worker bound' );
		} catch ( \LogicException $e ) {
			$this->assertSame( $refusal, $e->getMessage() );
		}
		$this->assertSame( [], $probe->arguments(), 'a refusal sets nothing' );
	}

	public function test_a_table_answering_nothing_and_a_non_table_emit_nothing(): void {
		$this->stub_table( 'mounted-4417', [] );
		( new Capture_Sink_Node() )->name( 'not-a-table-4417' );
		$capture = new Capture_Sink_Node();
		$this->probe( $capture )->fire_cb();
		$this->assertCount( 0, $capture->captured );
	}

	public function test_a_table_that_throws_costs_its_peers_nothing_then_escapes(): void {
		$boom = new \RuntimeException( 'boom-6620' );
		$bad  = new class( $boom ) extends Table_Node {
			public function __construct( private \RuntimeException $boom ) {
				parent::__construct();
			}
			public function probe_stats(): array {
				throw $this->boom;
			}
		};
		$bad->name( 'broken-6620' );
		$this->stub_table( 'healthy', [ self::record( 'healthy.p0' ) ] );
		$capture = new Capture_Sink_Node();
		$caught  = null;
		try {
			$this->probe( $capture )->fire_cb();
		} catch ( \RuntimeException $e ) {
			$caught = $e;
		}
		$this->assertSame( $boom, $caught );
		$this->assertCount( 1, $capture->captured );
	}

	public function test_a_real_table_sweeps_into_a_record_that_fits_the_line(): void {
		$dir = $this->make_temp_dir( 'table-probe-' );
		$this->use_base_dir( $dir );
		// The worker's own partition, which stays bound for the sweep.
		Core::$var['partition'] = '2';
		$table                  = new Table_Node();
		$table->name( 'lab-9:moa' );
		$table->arguments( [ 'moa:p2', '600', 'sqlite' ] );
		$table->sink( new Capture_Sink_Node() );
		$capture = new Capture_Sink_Node();
		$this->probe( $capture )->fire_cb();

		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 'lab-9:moa.p2', $capture->captured[0][ Message::VALUE ][ Tablestats_Record::IDENTITY ] );
		$this->assertLessThan( \Newspack_Nodes\Partition_Node::MAX_LINE_SIZE, Message::packed_size( $capture->captured[0] ) + 1 );
		$this->rmdir_recursive( $dir );
	}

	public function test_the_stock_topology_declares_the_probe_and_its_day_long_log(): void {
		$tsl = (string) \file_get_contents( \dirname( __DIR__, 2 ) . '/topologies/table-probe.tsl' );
		$this->assertStringContainsString( 'make_node Table_Probe tablestats 15', $tsl );
		$this->assertStringContainsString( '<config:logs_dir>/tablestats.p0 1048576 2 8 0 86400 86400', $tsl );
		$this->assertStringContainsString( 'connect_node tablestats tablestats:log', $tsl );
	}
}
