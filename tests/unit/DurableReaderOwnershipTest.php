<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Durable_Reader;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Remote_Consumer_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Topic_Probe_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Every durable reader asks whether its worker owns the source as its TSL
 * wrote it (ADR-33): a source naming `{partition}` is read in every worker,
 * a fixed one on worker p0 alone, and a reader built anywhere else idles.
 */
#[CoversClass( Consumer_Node::class )]
#[CoversClass( Durable_Reader::class )]
class DurableReaderOwnershipTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		unset( Core::$var['partition'], Core::$var['topology'] );
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/**
	 * A Consumer of a fixed log, built off p0, is built and idles: no source,
	 * no timer, no cursor, no quarantine, and no error line.
	 */
	public function test_off_partition_zero_a_consumer_of_a_fixed_log_idles(): void {
		$args             = [ "{$this->tmp}/marlin.p0", "{$this->tmp}/marlin-off.p2", "{$this->tmp}/marlin-dead.p2" ];
		Core::$recent_log = [];
		Core::$now        = 7213.0;

		$consumer = $this->built( Consumer_Node::class, 'marlin:consumer', $args, 2 );

		$this->assertSame( 0, $consumer->interval_ms, 'no timer is armed' );
		$this->assertNull( $this->read_private( $consumer, 'offsetlog' ), 'no offsetlog is built' );
		$this->assertNull( $this->read_private( $consumer, 'deadletter' ), 'no quarantine is built' );
		$this->assertNull( Core::node( 'marlin:consumer:source' ), 'no source is opened' );
		$this->assertSame( '', $this->read_private( $consumer, 'offsetlog_dir' ) );
		$this->assertSame( '', $this->read_private( $consumer, 'deadletter_dir' ) );
		$this->assertDirectoryDoesNotExist( "{$this->tmp}/marlin-off.p2" );
		$this->assertSame( 'IDLE', $consumer->dump_metadata()['polling'] );
		$this->assertSame(
			[ 'since' => 7213.0, 'reason' => "idle on partition 2: {$this->tmp}/marlin.p0 is read on worker partition 0 alone" ],
			$consumer->dump_metadata()['idle'] ?? null
		);
		$this->assertSame( 7213.0, $consumer->idle_since(), 'idle since it was built, so it vetoes no on-demand exit' );
		$this->assertSame( [], Core::$recent_log, 'idling off p0 is normal, so it writes no error line' );
		$this->assertSame( $args, $consumer->arguments(), 'the line replays as written' );
	}

	/** On worker p0 the same line reads its log. */
	public function test_on_partition_zero_a_consumer_of_a_fixed_log_reads(): void {
		$this->append( "{$this->tmp}/marlin.p0", 'marlin-3401' );
		$cap = new Capture_Sink_Node();

		$consumer = $this->built( Consumer_Node::class, 'marlin:consumer', [ "{$this->tmp}/marlin.p0", "{$this->tmp}/marlin-off.p0" ], 0, $cap );
		$consumer->poll();
		$consumer->poll();

		$this->assertSame( 'ACTIVE', $consumer->dump_metadata()['polling'] );
		$this->assertArrayNotHasKey( 'idle', $consumer->dump_metadata() );
		$this->assertSame( [ 'marlin-3401' ], \array_column( $cap->captured, Message::VALUE ) );
	}

	/** A log written per worker is read in every worker, each its own. */
	public function test_on_partition_two_a_partitioned_consumer_reads_its_own_log(): void {
		$this->append( "{$this->tmp}/marlin.p0", 'marlin-p0-3402' );
		$this->append( "{$this->tmp}/marlin.p2", 'marlin-p2-3402' );
		$cap = new Capture_Sink_Node();

		$consumer = $this->built( Consumer_Node::class, 'marlin:consumer', [ "{$this->tmp}/marlin.p{partition}", "{$this->tmp}/marlin-off.p{partition}" ], 2, $cap );
		$consumer->poll();
		$consumer->poll();

		$this->assertGreaterThan( 0, $consumer->interval_ms, 'it arms its timer' );
		$this->assertArrayNotHasKey( 'idle', $consumer->dump_metadata() );
		$this->assertSame( [ 'marlin-p2-3402' ], \array_column( $cap->captured, Message::VALUE ), 'p2 reads its own log alone' );
	}

	/** A segmented Tail of a fixed Log idles off p0 too. */
	public function test_off_partition_zero_a_tail_of_a_fixed_log_idles(): void {
		$tail = $this->built( Tail_Node::class, 'tern:tail', [ "{$this->tmp}/tern.log", "{$this->tmp}/tern-off.p4" ], 4 );

		$this->assertSame( 0, $tail->interval_ms );
		$this->assertSame( "idle on partition 4: {$this->tmp}/tern.log is read on worker partition 0 alone", $tail->dump_metadata()['idle']['reason'] ?? null );
	}

	/**
	 * A reader the broker builds is owned by the broker's choice, which asked
	 * `owns()` of the pair, so it reads on any partition.
	 */
	public function test_off_partition_zero_a_brokers_reader_is_owned(): void {
		$reader = $this->built( Remote_Consumer_Node::class, 'pull:firehose.p0', [ 'firehose.p0', "{$this->tmp}/pull-off/firehose.p0", "{$this->tmp}/pull-dead/firehose.p0" ], 6 );

		$this->assertGreaterThan( 0, $reader->interval_ms );
		$this->assertSame( 'ACTIVE', $reader->dump_metadata()['polling'] );
		$this->assertArrayNotHasKey( 'idle', $reader->dump_metadata() );
	}

	/** @return array<string,array{\Closure(Consumer_Node): mixed}> Label => an act that would wake an idle reader. */
	public static function waking_acts(): array {
		return [
			'play'          => [ static fn ( Consumer_Node $reader ) => $reader->interpreter()?->dispatch( 'play', [] ) ],
			'step'          => [ static fn ( Consumer_Node $reader ) => $reader->interpreter()?->dispatch( 'step', [] ) ],
			'pause'         => [ static fn ( Consumer_Node $reader ) => $reader->interpreter()?->dispatch( 'pause', [] ) ],
			'a frame seek'  => [ static fn ( Consumer_Node $reader ) => $reader->seek_frame( 0 ) ],
			'a seek to end' => [ static fn ( Consumer_Node $reader ) => $reader->next_offset( 'end' ) ],
			'a poll'        => [ static fn ( Consumer_Node $reader ) => $reader->poll() ],
		];
	}

	/**
	 * An idle reader refuses whatever would wake it or move it out of its one
	 * state, naming the rule, and stays idle.
	 *
	 * @param \Closure(Consumer_Node): mixed $act The act to refuse.
	 */
	#[DataProvider( 'waking_acts' )]
	public function test_an_idle_consumer_refuses_to_wake( \Closure $act ): void {
		$consumer = $this->built( Consumer_Node::class, 'marlin:consumer', [ "{$this->tmp}/marlin.p0", "{$this->tmp}/marlin-off.p5" ], 5 );

		$caught = $this->caught( static fn () => $act( $consumer ), 'an idle reader must refuse to wake' );

		$this->assertStringContainsString( "marlin:consumer is idle on partition 5: {$this->tmp}/marlin.p0 is read on worker partition 0 alone", $caught->getMessage() );
		$this->assertSame( 0, $consumer->interval_ms );
		$this->assertSame( 'IDLE', $consumer->dump_metadata()['polling'] );
	}

	/** A replay naming a fixed log off p0 retracts what the reader had built. */
	public function test_a_replay_onto_a_fixed_log_off_partition_zero_retracts_the_reader(): void {
		$consumer = $this->built( Consumer_Node::class, 'marlin:consumer', [ "{$this->tmp}/marlin.p{partition}", "{$this->tmp}/marlin-off.p{partition}" ], 3 );
		$this->assertNotNull( Core::node( 'marlin:consumer:offsetlog' ) );

		Core::$var['partition'] = '3';
		$consumer->arguments( [ "{$this->tmp}/marlin.p0", "{$this->tmp}/marlin-off.p3" ] );

		$this->assertSame( 'IDLE', $consumer->dump_metadata()['polling'] );
		$this->assertSame( 0, $consumer->interval_ms );
		$this->assertNull( Core::node( 'marlin:consumer:offsetlog' ), 'the cursor sidecar is retracted' );
		$this->assertNull( Core::node( 'marlin:consumer:source' ), 'the source is retracted' );
	}

	/**
	 * A reader that polled and is then replayed onto a fixed log off p0 is
	 * back in its never-polled state, so a probe sweep claims it no more.
	 */
	public function test_a_reader_replayed_idle_after_polling_leaves_the_probe_sweep(): void {
		Core::$now              = 1000;
		Core::$var['topology']  = 'marlin-fleet';
		Core::$var['partition'] = '3';
		( new Router_Node() )->name( '_router' );
		$this->append( "{$this->tmp}/marlin.p3", 'marlin-p3-3404' );
		$consumer = new Consumer_Node();
		$consumer->name( 'marlin:consumer' );
		$consumer->sink( new Capture_Sink_Node() );
		$consumer->arguments( [ "{$this->tmp}/marlin.p{partition}", "{$this->tmp}/marlin-off.p{partition}" ] );
		$consumer->poll();
		$this->assertNotNull( $consumer->get_state( 'READY' ), 'the reader polled' );

		$consumer->arguments( [ "{$this->tmp}/marlin.p0", "{$this->tmp}/marlin-off.p3" ] );
		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertNull( $consumer->get_state( 'READY' ) );
		$this->assertFalse( $this->read_private( $consumer, 'poll_initialized' ) );
		$this->assertNull( $this->read_private( $consumer, 'poll_cb' ) );
		$this->assertSame( [], $capture->captured, 'the idle reader sends no record' );
	}

	/** @return array<string,array{class-string<Consumer_Node>,string,list<string>}> Label => a reader, its type and a per-worker line sharing a dir. */
	public static function shared_dir_lines(): array {
		return [
			'a Consumer, fixed offsetlog'  => [ Consumer_Node::class, 'Consumer', [ '{tmp}/marlin.p{partition}', '{tmp}/marlin-off', '{tmp}/marlin-dead.p{partition}' ] ],
			'a Consumer, fixed deadletter' => [ Consumer_Node::class, 'Consumer', [ '{tmp}/marlin.p{partition}', '{tmp}/marlin-off.p{partition}', '{tmp}/marlin-dead' ] ],
			'a Tail, fixed offsetlog'      => [ Tail_Node::class, 'Tail', [ '{tmp}/tern.{partition}.log', '{tmp}/tern-off' ] ],
		];
	}

	/**
	 * Every worker of a per-worker line would commit one cursor or quarantine
	 * into one queue, so the line fails to load, whatever the reader.
	 *
	 * @param class-string<Consumer_Node> $class The reader class.
	 * @param string                      $type  Its shell name.
	 * @param list<string>                $args  The line's arguments.
	 */
	#[DataProvider( 'shared_dir_lines' )]
	public function test_a_per_partition_reader_sharing_a_dir_fails_to_load( string $class, string $type, array $args ): void {
		Core::$var['partition'] = '3';
		$reader                 = new $class();
		$reader->name( 'marlin:reader-3403' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "{$type} marlin:reader-3403: a per-partition source needs per-partition offsetlog and deadletter dirs; add {partition}" );
		$reader->arguments( \str_replace( '{tmp}', $this->tmp, $args ) );
	}

	/**
	 * Build a reader with `make_node`'s sequence while `$partition` is bound.
	 *
	 * @template T of \Newspack_Nodes\Node
	 * @param class-string<T> $class     The reader class.
	 * @param string          $name      Its name.
	 * @param list<string>    $args      Its arguments, as written.
	 * @param int             $partition The worker partition bound.
	 * @param Capture_Sink_Node|null $sink Its sink.
	 * @return T
	 */
	private function built( string $class, string $name, array $args, int $partition, ?Capture_Sink_Node $sink = null ): object {
		Core::$var['partition'] = (string) $partition;
		try {
			$reader = new $class();
			$reader->name( $name );
			$reader->sink( $sink ?? new Capture_Sink_Node() );
			$reader->arguments( $args );
		} finally {
			unset( Core::$var['partition'] );
		}
		return $reader;
	}

	/** Append one record carrying `$value` to the Partition at `$dir`. */
	private function append( string $dir, string $value ): void {
		$writer = new Partition_Node();
		$writer->arguments( [ $dir ] );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = $value;
		$writer->fill( $message );
		$writer->flush();
	}
}
