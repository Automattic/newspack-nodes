<?php
/**
 * WorkerStopLineTest: every cooperative stop names itself once.
 *
 * Each stop writes one `<label>: stopping — <reason> (age <N>s)` line to the
 * `newspack_nodes/stderr` seam, which the event logger records in the
 * firehose. A routine stop — an operator stop, a restart, the runtime budget,
 * the idle window — goes to the seam alone, so it never reaches `error_log`
 * through the stderr handler; a fault goes to both.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Core;
use Newspack_Nodes\Idle_Reporter;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Base;

#[CoversClass( Worker_Base::class )]
#[CoversClass( Core::class )]
final class WorkerStopLineTest extends TestCase {

	/** The monotonic instant the worker acquires at. */
	private const STARTED = 5000.0;

	/** Seconds the worker has run when it is asked to continue. */
	private const AGE = 413;

	/** An idle window apart from every default. */
	private const IDLE_SECONDS = 37;

	/** A runtime budget apart from the 595s default, and spent at AGE. */
	private const MAX_RUNTIME = 389;

	private string $tmp;

	/** The `memory_limit` the tests replace, restored in tearDown. */
	private string|false $saved_memory_limit = false;

	/** @var list<string> What reached the `newspack_nodes/stderr` seam. */
	private array $seam = [];

	/** @var list<string> The keyword each seam line was filed under. */
	private array $keywords = [];

	protected function setUp(): void {
		parent::setUp();
		$this->tmp               = $this->make_temp_dir( 'worker-stop-line-' );
		Worker_Base::$last_error = static fn (): ?array => null;
		Worker_Base::$monotonic  = static fn (): float => self::STARTED;
		$this->saved_memory_limit = \ini_set( 'memory_limit', '2731M' );
		$seam                    = &$this->seam;
		$keywords                = &$this->keywords;
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line, string $keyword ) use ( &$seam, &$keywords ): void {
				$seam[]     = $line;
				$keywords[] = $keyword;
			}
		);
	}

	protected function tearDown(): void {
		Worker_Base::$last_error = null;
		Worker_Base::$monotonic  = null;
		Worker_Base::$db_probe   = null;
		Worker_Base::$memory_usage = null;
		if ( false !== $this->saved_memory_limit ) {
			\ini_set( 'memory_limit', $this->saved_memory_limit );
		}
		Core::cleanup_all_nodes();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/**
	 * Every stop: how to bring it about, the reason its line names, and
	 * whether it is a fault the stderr handler, and so `error_log`, sees.
	 *
	 * @return array<string,array{0:\Closure(StopLineWorker,string):void,1:string,2:bool}>
	 */
	public static function stops(): array {
		return [
			'lock lost'           => [ static fn ( StopLineWorker $w ) => $w->drop_lock_for_test(), 'lock lost', true ],
			'lock dir gone'       => [ static fn ( StopLineWorker $w, string $dir ) => self::remove_tree( $dir ), 'lock dir gone', true ],
			'stop requested'      => [ static fn ( StopLineWorker $w, string $dir ) => Lock_Node::request_stop_at( $dir ), 'stop requested', false ],
			'restart requested'   => [ static fn ( StopLineWorker $w, string $dir ) => \file_put_contents( $dir . '/' . Lock_Node::RESTART_FLAG, '1' ), 'restart requested', false ],
			'lock heartbeat gone' => [ static fn ( StopLineWorker $w, string $dir ) => \unlink( $dir . '/' . Lock_Node::HEARTBEAT_FILE ), 'lock heartbeat gone', true ],
			'lock stolen'         => [ static fn ( StopLineWorker $w, string $dir ) => \file_put_contents( $dir . '/' . Lock_Node::HEARTBEAT_FILE, (string) ( \getmypid() + 7717 ) ), 'lock stolen by pid ' . ( \getmypid() + 7717 ), true ],
			'timeout'             => [ static fn ( StopLineWorker $w ) => $w->set_max_runtime_for_test( self::MAX_RUNTIME ), 'timeout', false ],
			'memory'              => [ static fn () => Worker_Base::$memory_usage = static fn (): int => 2458 * 1048576, 'memory watermark (2458MB / 2731MB, 90%)', true ],
			'db liveness'         => [ static fn ( StopLineWorker $w ) => $w->fail_db_checks_for_test(), 'db check failed 3 times', true ],
			'idle'                => [ static fn ( StopLineWorker $w ) => ( new StopLineIdleProbe( \microtime( true ) - self::IDLE_SECONDS - 6 ) )->name( 'kiwi-probe' ), 'idle: no message for ' . self::IDLE_SECONDS . 's', false ],
		];
	}

	/**
	 * @param \Closure(StopLineWorker,string):void $cause
	 */
	#[DataProvider( 'stops' )]
	public function test_each_stop_writes_one_line_naming_it_and_the_age( \Closure $cause, string $reason, bool $fault ): void {
		$handled = $this->capture_stderr();
		$w       = $this->worker();
		$cause( $w, "{$this->tmp}/locks/kiwi-workers.p3.lock.d" );
		Worker_Base::$monotonic = static fn (): float => self::STARTED + self::AGE;

		$this->assertFalse( $w->should_continue_until_stop() );

		$lines = self::stderr_lines( new \ArrayObject( $this->seam ), 'stopping' );
		$this->assertSame( [ "kiwi-workers.p3: stopping — {$reason} (age " . self::AGE . 's)' ], $lines );
		$this->assertSame( $fault ? $lines : [], self::stderr_lines( $handled, 'stopping' ), $fault ? 'a fault also reaches error_log' : 'a routine stop never reaches error_log' );
		$this->assertSame( [ $fault ? 'stderr' : 'worker (stop)' ], $this->keywords, 'a routine stop is filed apart from the errors' );
	}

	private static function remove_tree( string $dir ): void {
		foreach ( \glob( "{$dir}/*" ) ?: [] as $file ) {
			\unlink( $file );
		}
		\rmdir( $dir );
	}

	private function worker(): StopLineWorker {
		$w = new StopLineWorker( $this->tmp, 'kiwi-workers', 3, on_demand_idle: self::IDLE_SECONDS );
		$this->assertTrue( $w->acquire() );
		return $w;
	}
}

/** A worker whose runtime budget and DB probe a test sets. */
class StopLineWorker extends Worker_Base {

	private int $db_checks = 0;

	public function set_max_runtime_for_test( int $seconds ): void {
		$this->max_runtime = $seconds;
	}

	public function drop_lock_for_test(): void {
		$this->release();
	}

	public function fail_db_checks_for_test(): void {
		Worker_Base::$db_probe = static fn (): bool => false;
		$this->db_checks       = self::DB_CHECK_MAX_FAILURES;
	}

	/** Ask until the worker stops, re-opening the DB window each time it asks. */
	public function should_continue_until_stop(): bool {
		for ( $i = 0; $i <= $this->db_checks; $i++ ) {
			$this->last_db_check   = 0.0;
			$this->last_idle_check = 0.0;
			if ( ! $this->should_continue() ) {
				return false;
			}
		}
		return true;
	}
}

/** A reporter quiet since a fixed instant. */
class StopLineIdleProbe extends Node implements Idle_Reporter {

	public function __construct( private float $since ) {
		parent::__construct();
	}

	public function idle_since(): ?float {
		return $this->since;
	}
}
